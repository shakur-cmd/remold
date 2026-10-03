declare const process: { env: Record<string, string | undefined> };
import { v } from "convex/values";
import { httpAction, internalAction, internalMutation, internalQuery, type ActionCtx, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { MAX_ATTEMPTS, addNote, decide, exclusion, followUpsOf, logActivity, recipientOf, release, reserve, setStatus, standardItem, stateOf, suppress, value } from "./lib/campaign";
import { addressIn, compose, fromHeader, inboundDomain, normalAddress, replyPart, fingerprint, resendPost, settingsProblems, validAddress, verifySvix, UNKNOWN, type Outcome } from "./lib/campaignText";

// The campaign sender. An approval fixed each email's recipients as queued rows (see
// snapshot in lib/campaign.ts). Every minute a tick claims a bounded batch of due rows
// in one mutation (daily counts reserved, each row leased, its exact message stored),
// then sends each through Resend with the row id as Idempotency-Key. Before each send
// it checks again that the campaign is active and the approved email unchanged, so a
// pause or stop takes effect mid-batch.
// When Resend's answer is lost (the action died, or no response), the outcome is
// unknown: the row keeps its daily count and later tries the same stored bytes with
// the same key, which Resend answers with the first send. Resend forgets keys after
// 24 hours, so a row still unknown after 23 hours is failed and never retried.
const MINUTE = 60_000, HOUR = 60 * MINUTE, LEASE = 5 * MINUTE, BATCH = 25, RUNS_PER_TICK = 20, UNKNOWN_AFTER = 23 * HOUR;
const MAX_FORWARD_ATTEMPTS = 5, FORWARDS_PER_SEND = 3;

type Claimed = { sendId: Id<"emailSends">; attempt: number; payload: string; key: string };

// An email is sent once every row has an outcome; a follow-up also waits for the email
// before it, whose remaining sends would still add rows here.
async function settle(ctx: MutationCtx, emailId: Id<"records">) {
  const email = await ctx.db.get(emailId), item = email && await standardItem(ctx, email.orgId, "email");
  if (!email || !item?.f.status) return;
  const status = value(email, item.f.status);
  if (status !== "approved" && status !== "sending") return;
  for (const open of ["queued", "sending"] as const) if (await ctx.db.query("emailSends").withIndex("by_email_status", (q) => q.eq("emailRecordId", email._id).eq("status", open)).first()) return;
  const previousId = value(email, item.f.followsUp) as Id<"records"> | undefined, previous = previousId ? await ctx.db.get(previousId) : null;
  if (previousId ? !previous || value(previous, item.f.status) !== "sent" : !(await ctx.db.query("emailSends").withIndex("by_email", (q) => q.eq("emailRecordId", email._id)).first())) return;
  await setStatus(ctx, email, item, "sent");
}

// Reads stay bounded: only due queued rows, a few batches' worth per email.
async function claimFor(ctx: MutationCtx, run: Doc<"emailRuns">, now: number, room: number): Promise<Claimed[]> {
  const email = await ctx.db.get(run.emailRecordId);
  if (!email) { await ctx.db.patch(run._id, { live: false }); return []; }
  const state = await stateOf(ctx, email, now), person = await standardItem(ctx, email.orgId, "person");
  if (!state || state.problems.length || !state.campaign || !person) return [];
  const { org, item, campaign } = state, settings = org.emailSettings!, inbound = inboundDomain(), sendTo = (value(email, item.f.sendTo) as string | undefined) ?? "notReplied";
  const template = { subject: String(value(email, item.f.subject) ?? ""), body: String(value(email, item.f.body) ?? "") }, out: Claimed[] = [];
  for (const send of await ctx.db.query("emailSends").withIndex("by_email_due", (q) => q.eq("emailRecordId", email._id).eq("status", "queued").lte("notBefore", now)).take(room * 4)) {
    if (out.length >= room) break;
    if (send.uncertain && (send.firstAttemptAt ?? now) < now - UNKNOWN_AFTER) { await ctx.db.patch(send._id, { status: "failed", failReason: UNKNOWN }); continue; }
    if (send.attempts >= MAX_ATTEMPTS) { await ctx.db.patch(send._id, { status: "failed", failReason: send.failReason ?? `Gave up after ${MAX_ATTEMPTS} attempts` }); continue; }
    const previous = send.previousSendId ? await ctx.db.get(send.previousSendId) : null;
    const { reason, wrote } = await decide(ctx, org._id, campaign._id, send.to, previous, sendTo);
    // A reply Gmail sync found counts on the send it answered.
    if (wrote && previous) await ctx.db.patch(previous._id, { repliedAt: now });
    if (reason) { if (!send.uncertain) await release(ctx, org._id, send.reservedDay); await ctx.db.patch(send._id, { status: "skipped", skipReason: reason, reservedDay: undefined }); continue; }
    // A row whose last try is unknown still holds its count from then.
    const day = send.reservedDay ?? await reserve(ctx, org._id, settings.dailyLimit ?? 0, now);
    if (day === null) break;
    // Only a try whose outcome is unknown repeats its stored bytes; anything else is composed from what is approved now.
    let payload = send.uncertain ? send.payload : undefined;
    if (!payload) {
      const record = await ctx.db.get(send.personRecordId), recipient = record ? await recipientOf(ctx, person, record) : { name: "" };
      const message = compose(template, { ...recipient, token: send.token }, settings.postalAddress!, send.token);
      payload = JSON.stringify({ from: fromHeader(settings.fromName, settings.fromAddress!), to: [send.to], subject: message.subject, text: message.text, html: message.html, headers: message.headers, reply_to: inbound ? `r-${send.token}@${inbound}` : state.replyTo!, tags: [{ name: "send", value: send._id }] });
    }
    await ctx.db.patch(send._id, { status: "sending", lease: now + LEASE, attempts: send.attempts + 1, reservedDay: day, payload, subject: send.subject ?? JSON.parse(payload).subject, firstAttemptAt: send.firstAttemptAt ?? now });
    // The key follows the bytes, so a recomposed message never reuses a key Resend saw with other bytes.
    out.push({ sendId: send._id, attempt: send.attempts + 1, payload, key: `${send._id}:${fingerprint(payload)}` });
  }
  if (out.length && value(email, item.f.status) === "approved") await setStatus(ctx, email, item, "sending");
  await settle(ctx, email._id);
  return out;
}

export const claim = internalMutation({ args: {}, handler: async (ctx) => {
  const now = Date.now();
  // A lease that ran out means the action died mid-send: the outcome is unknown.
  for (const send of await ctx.db.query("emailSends").withIndex("by_status_lease", (q) => q.eq("status", "sending").lt("lease", now)).take(100)) {
    if ((send.firstAttemptAt ?? now) < now - UNKNOWN_AFTER) await ctx.db.patch(send._id, { status: "failed", failReason: UNKNOWN, lease: undefined });
    else await ctx.db.patch(send._id, { status: "queued", lease: undefined, uncertain: true });
  }
  // Runs are visited least recently checked first, so blocked runs cannot starve the rest.
  const out: Claimed[] = [];
  for (const run of await ctx.db.query("emailRuns").withIndex("by_live_checked", (q) => q.eq("live", true)).take(RUNS_PER_TICK)) {
    if (out.length >= BATCH) break;
    await ctx.db.patch(run._id, { checkedAt: now });
    if (run.confirmed) out.push(...(await claimFor(ctx, run, now, BATCH - out.length)));
  }
  return out;
} });

// The last check before one send: still allowed, still this attempt, still the
// approved email. If not, the row goes back to the queue (or is skipped: a new
// unsubscribe, or the approval withdrawn) and a count it took for this try is released.
export const begin = internalMutation({ args: { sendId: v.id("emailSends"), attempt: v.number() }, handler: async (ctx, { sendId, attempt }) => {
  const send = await ctx.db.get(sendId);
  if (!send || send.status !== "sending" || send.attempts !== attempt) return false;
  const email = await ctx.db.get(send.emailRecordId), state = email ? await stateOf(ctx, email, Date.now()) : null, reason = await exclusion(ctx, send.orgId, send.to, send.campaignRecordId);
  if (state && !state.problems.length && !reason) return true;
  const skip = reason ?? (!state?.run ? "approval withdrawn" : undefined);
  if (!send.uncertain) await release(ctx, send.orgId, send.reservedDay);
  const held = send.uncertain ? {} : { reservedDay: undefined };
  await ctx.db.patch(send._id, skip ? { status: "skipped", skipReason: skip, lease: undefined, ...held } : { status: "queued", attempts: send.attempts - 1, lease: undefined, ...held });
  return false;
} });

const outcome = v.union(v.object({ ok: v.literal(true), id: v.string() }), v.object({ ok: v.literal(false), retry: v.boolean(), unknown: v.optional(v.boolean()), reason: v.string() }));
async function delivered(ctx: MutationCtx, send: Doc<"emailSends">, providerId: string) {
  const sentAt = Date.now();
  await ctx.db.patch(send._id, { status: "sent", providerId, sentAt, lease: undefined, uncertain: false });
  await logActivity(ctx, send.orgId, send.personRecordId, `Sent: ${send.subject ?? ""}`);
  await followUpsOf(ctx, { ...send, status: "sent", sentAt });
}
export const finish = internalMutation({ args: { sendId: v.id("emailSends"), attempt: v.number(), outcome }, handler: async (ctx, { sendId, attempt, outcome }) => {
  const send = await ctx.db.get(sendId);
  if (!send || send.status !== "sending" || send.attempts !== attempt) return;
  if (outcome.ok) await delivered(ctx, send, outcome.id);
  else {
    // Once a try may have gone out, the count stays taken until the outcome is known.
    const uncertain = send.uncertain || outcome.unknown === true;
    if (!uncertain) await release(ctx, send.orgId, send.reservedDay);
    await ctx.db.patch(send._id, { status: outcome.retry && send.attempts < MAX_ATTEMPTS ? "queued" : "failed", failReason: outcome.reason, lease: undefined, uncertain, ...(uncertain ? {} : { reservedDay: undefined }) });
  }
  await settle(ctx, send.emailRecordId);
} });

// Replies to forward to the org, through the same settings gates and daily counts.
type Forward = { forwardId: Id<"emailForwards">; attempt: number; payload: string; key: string };
export const claimForwards = internalMutation({ args: {}, handler: async (ctx): Promise<Forward[]> => {
  const now = Date.now(), out: Forward[] = [];
  for (const forward of await ctx.db.query("emailForwards").withIndex("by_status", (q) => q.eq("status", "pending")).take(20)) {
    if ((forward.lease ?? 0) > now) continue;
    // A lease that ran out means the action died mid-send: whether it went is unknown.
    if (forward.lease && !forward.uncertain) await ctx.db.patch(forward._id, { uncertain: true });
    const org = await ctx.db.get(forward.orgId);
    if (!org || org.flags?.readonly || settingsProblems(org.emailSettings).length) continue;
    const day = forward.reservedDay ?? await reserve(ctx, org._id, org.emailSettings?.dailyLimit ?? 0, now);
    if (day === null) continue;
    await ctx.db.patch(forward._id, { reservedDay: day, lease: now + LEASE, attempts: forward.attempts + 1 });
    out.push({ forwardId: forward._id, attempt: forward.attempts + 1, payload: forward.payload, key: `forward-${forward.eventId}` });
  }
  return out;
} });
export const forwarded = internalMutation({ args: { forwardId: v.id("emailForwards"), attempt: v.number(), outcome }, handler: async (ctx, { forwardId, attempt, outcome }) => {
  const forward = await ctx.db.get(forwardId);
  if (!forward || forward.status !== "pending" || forward.attempts !== attempt) return;
  if (outcome.ok) { await ctx.db.patch(forward._id, { status: "sent", lease: undefined }); return; }
  const uncertain = forward.uncertain || outcome.unknown === true;
  if (!uncertain) await release(ctx, forward.orgId, forward.reservedDay);
  await ctx.db.patch(forward._id, { status: outcome.retry && forward.attempts < MAX_FORWARD_ATTEMPTS ? "pending" : "failed", failReason: outcome.reason, lease: undefined, uncertain, ...(uncertain ? {} : { reservedDay: undefined }) });
} });

export const tick = internalAction({ args: {}, handler: async (ctx) => {
  const claimed: Claimed[] = await ctx.runMutation(internal.campaignSend.claim, {});
  let sent = 0;
  for (const item of claimed) {
    if (!(await ctx.runMutation(internal.campaignSend.begin, { sendId: item.sendId, attempt: item.attempt }))) continue;
    const result: Outcome = await resendPost(item.payload, item.key);
    await ctx.runMutation(internal.campaignSend.finish, { sendId: item.sendId, attempt: item.attempt, outcome: result });
    if (result.ok) sent++;
  }
  const forwards: Forward[] = await ctx.runMutation(internal.campaignSend.claimForwards, {});
  for (const forward of forwards) await ctx.runMutation(internal.campaignSend.forwarded, { forwardId: forward.forwardId, attempt: forward.attempt, outcome: await resendPost(forward.payload, forward.key) });
  return { claimed: claimed.length, sent, forwards: forwards.length };
} });

// Webhooks: each Svix id is applied once.
async function firstTime(ctx: MutationCtx, eventId: string) {
  if (await ctx.db.query("webhookEvents").withIndex("by_event", (q) => q.eq("provider", "resend").eq("eventId", eventId)).unique()) return false;
  await ctx.db.insert("webhookEvents", { provider: "resend", eventId, at: Date.now() });
  return true;
}
export const seen = internalQuery({ args: { eventIds: v.array(v.string()) }, handler: async (ctx, { eventIds }) => {
  for (const eventId of eventIds) if (await ctx.db.query("webhookEvents").withIndex("by_event", (q) => q.eq("provider", "resend").eq("eventId", eventId)).unique()) return true;
  return false;
} });

export const track = internalMutation({ args: { eventId: v.string(), type: v.string(), providerId: v.optional(v.string()), tag: v.optional(v.string()), link: v.optional(v.string()), bounce: v.optional(v.string()) }, handler: async (ctx, a) => {
  if (!(await firstTime(ctx, a.eventId))) return;
  const tagged = a.tag ? ctx.db.normalizeId("emailSends", a.tag) : null;
  let send = (tagged && await ctx.db.get(tagged)) || (a.providerId ? await ctx.db.query("emailSends").withIndex("by_provider", (q) => q.eq("providerId", a.providerId)).first() : null);
  if (!send) return;
  // Any news about a send whose answer was lost settles it as sent.
  if (send.status !== "sent" && send.uncertain && a.providerId && /^email\.(sent|delivered|delivery_delayed|opened|clicked|bounced|complained)$/.test(a.type)) { await delivered(ctx, send, a.providerId); await settle(ctx, send.emailRecordId); send = (await ctx.db.get(send._id))!; }
  const now = Date.now(), about = (what: string) => logActivity(ctx, send!.orgId, send!.personRecordId, `${what}: ${send!.subject ?? ""}`);
  if (a.type === "email.delivered" && !send.deliveredAt) await ctx.db.patch(send._id, { deliveredAt: now });
  if (a.type === "email.opened") await ctx.db.patch(send._id, { opens: (send.opens ?? 0) + 1, openedAt: send.openedAt ?? now });
  if (a.type === "email.clicked") {
    await ctx.db.patch(send._id, { clicks: (send.clicks ?? 0) + 1, clickedAt: send.clickedAt ?? now, lastLink: a.link ?? send.lastLink });
    if (!send.clickedAt) await about("Clicked");
  }
  // Only a permanent bounce says the address is bad; a full mailbox may work tomorrow.
  if (a.type === "email.bounced" && a.bounce === "Permanent" && !send.bouncedAt) { await ctx.db.patch(send._id, { bouncedAt: now }); await suppress(ctx, send.orgId, send.to, "bounce"); await about("Bounced"); }
  if (a.type === "email.complained" && !send.complainedAt) { await ctx.db.patch(send._id, { complainedAt: now }); await suppress(ctx, send.orgId, send.to, "complaint"); }
  if (a.type === "email.failed" && send.status === "sent") await ctx.db.patch(send._id, { status: "failed", failReason: "Resend could not deliver it" });
} });

// A reply to r-<token>@<inbound domain>: marked on its send and kept as a Note, once
// per Resend email. The first few per send are also queued to forward to the org's
// reply-to address, so the person sees them in their inbox; the tick sends them.
export const replied = internalMutation({ args: { eventId: v.string(), emailId: v.string(), token: v.string(), from: v.string(), text: v.string() }, handler: async (ctx, a) => {
  if (!(await firstTime(ctx, a.eventId)) || !(await firstTime(ctx, `received:${a.emailId}`))) return;
  const send = await ctx.db.query("emailSends").withIndex("by_token", (q) => q.eq("token", a.token)).unique();
  if (!send || send.status !== "sent") return;
  if (!send.repliedAt) { await ctx.db.patch(send._id, { repliedAt: Date.now() }); await logActivity(ctx, send.orgId, send.personRecordId, `Replied: ${send.subject ?? ""}`); }
  await addNote(ctx, send.orgId, send.personRecordId, a.text);
  if ((send.forwards ?? 0) >= FORWARDS_PER_SEND) return;
  const email = await ctx.db.get(send.emailRecordId), state = email ? await stateOf(ctx, email, Date.now()) : null, settings = state?.org.emailSettings;
  if (!state?.replyTo || !settings?.fromAddress) return;
  const person = await ctx.db.get(send.personRecordId);
  const payload = JSON.stringify({ from: fromHeader(settings.fromName, settings.fromAddress), to: [state.replyTo], ...(a.from ? { reply_to: a.from } : {}), subject: `Re: ${send.subject ?? ""}`, text: `${person?.title || a.from} replied to "${send.subject ?? ""}":\n\n${a.text || "(Remold could not read the reply text.)"}` });
  await ctx.db.patch(send._id, { forwards: (send.forwards ?? 0) + 1 });
  await ctx.db.insert("emailForwards", { orgId: send.orgId, sendId: send._id, eventId: a.eventId, payload, status: "pending", attempts: 0 });
} });

async function received(ctx: ActionCtx, eventId: string, data: Record<string, unknown>) {
  const domain = inboundDomain(), to = Array.isArray(data.to) ? data.to : [], emailId = typeof data.email_id === "string" ? data.email_id.slice(0, 200) : eventId;
  const token = domain && to.map((address) => /^r-([a-f0-9]{32})@(.+)$/.exec(addressIn(String(address)) ?? "")).find((match) => match?.[2] === domain)?.[1];
  if (!token || await ctx.runQuery(internal.campaignSend.seen, { eventIds: [eventId, `received:${emailId}`] })) return;
  let text = "";
  if (process.env.RESEND_API_KEY && typeof data.email_id === "string") {
    try {
      const response = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(data.email_id)}`, { redirect: "error", headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}` }, signal: AbortSignal.timeout(10_000) });
      const json = response.ok ? await response.json() as { text?: unknown } : {};
      if (typeof json.text === "string") text = json.text;
    } catch { /* The reply still counts; only its text is missing. */ }
  }
  await ctx.runMutation(internal.campaignSend.replied, { eventId, emailId, token, from: addressIn(String(data.from ?? "")) ?? "", text: replyPart(text).slice(0, 5000) });
}

export const resendWebhook = httpAction(async (ctx, request) => {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return new Response("Webhook secret is not set", { status: 503 });
  const body = await request.text();
  if (!(await verifySvix(secret, request.headers, body, Date.now()))) return new Response("Invalid signature", { status: 401 });
  let event: { type?: unknown; data?: Record<string, any> };
  try { event = JSON.parse(body); } catch { return new Response("Invalid JSON", { status: 400 }); }
  const eventId = request.headers.get("svix-id")!, data = event?.data ?? {};
  if (event?.type === "email.received") { await received(ctx, eventId, data); return new Response("ok"); }
  const tags = data.tags, tag = Array.isArray(tags) ? tags.find((t: any) => t?.name === "send")?.value : tags?.send;
  const text = (x: unknown, max = 2000) => (typeof x === "string" ? x.slice(0, max) : undefined), fields = { providerId: text(data.email_id, 200), tag: text(tag, 64), link: text(data.click?.link), bounce: text(data.bounce?.type, 40) };
  await ctx.runMutation(internal.campaignSend.track, { eventId, type: String(event?.type ?? ""), ...Object.fromEntries(Object.entries(fields).filter(([, x]) => x !== undefined)) });
  return new Response("ok");
});

// GET only asks, so a link scanner that fetches the URL unsubscribes nobody. POST
// (the button, or a mail app's one-click per RFC 8058) unsubscribes. Every token,
// known or not, gets the same pages.
const page = (title: string, text: string, button: boolean) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#18181b}button{font:inherit;padding:.5rem 1rem;border:0;border-radius:.375rem;background:#18181b;color:#fff;cursor:pointer}</style></head><body><h1>${title}</h1><p>${text}</p>${button ? `<form method="post"><button type="submit">Unsubscribe</button></form>` : ""}</body></html>`;
const ASK = page("Unsubscribe", "Stop getting these emails?", true), DONE = page("You are unsubscribed", "You will not get these emails again.", false);
export const unsubscribePage = httpAction(async (ctx, request) => {
  const token = new URL(request.url).pathname.split("/")[2] ?? "";
  if (request.method === "POST" && /^[a-f0-9]{32}$/.test(token)) await ctx.runMutation(internal.campaignSend.unsubscribe, { token });
  return new Response(request.method === "POST" ? DONE : ASK, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
});
export const unsubscribe = internalMutation({ args: { token: v.string() }, handler: async (ctx, { token }) => {
  const send = await ctx.db.query("emailSends").withIndex("by_token", (q) => q.eq("token", token)).unique();
  if (!send?.to || send.unsubscribedAt) return;
  await ctx.db.patch(send._id, { unsubscribedAt: Date.now() });
  await suppress(ctx, send.orgId, send.to, "unsubscribe");
  await logActivity(ctx, send.orgId, send.personRecordId, `Unsubscribed: ${send.subject ?? ""}`);
} });

// One email to one address, outside any campaign (Job B's booking emails), through the
// same settings gates and daily counts. Bounced and complaining addresses are refused.
export const reserveOne = internalMutation({ args: { orgId: v.id("orgs"), to: v.string() }, handler: async (ctx, { orgId, to }): Promise<Ticket> => {
  const org = await ctx.db.get(orgId), address = normalAddress(to);
  const problems = org ? settingsProblems(org.emailSettings) : ["No workspace"];
  if (org?.flags?.readonly) problems.push("The workspace is read only");
  if (!validAddress(address)) problems.push("Invalid address");
  else if (["bounced", "complained"].includes((await exclusion(ctx, orgId, address)) ?? "")) problems.push("This address bounced or complained");
  if (!org || problems.length) return { status: "blocked" as const, problems };
  const settings = org.emailSettings!, day = await reserve(ctx, orgId, settings.dailyLimit ?? 0, Date.now());
  if (day === null) return { status: "limited" as const };
  return { status: "ok" as const, day, address, from: fromHeader(settings.fromName, settings.fromAddress!), postalAddress: settings.postalAddress!, ...(settings.replyTo ? { replyTo: settings.replyTo } : {}) };
} });
export const releaseOne = internalMutation({ args: { orgId: v.id("orgs"), day: v.number() }, handler: (ctx, { orgId, day }) => release(ctx, orgId, day) });
type Ticket = { status: "blocked"; problems: string[] } | { status: "limited" } | { status: "ok"; day: number; address: string; from: string; postalAddress: string; replyTo?: string };
export type Transactional = Exclude<Ticket, { status: "ok" }> | { status: "sent"; id: string } | { status: "failed"; reason: string; unknown?: boolean };
// An unknown outcome keeps its daily count; retry with the same idempotencyKey within a day.
export async function sendTransactional(ctx: ActionCtx, mail: { orgId: Id<"orgs">; to: string; subject: string; text: string; replyTo?: string; idempotencyKey?: string }): Promise<Transactional> {
  const ticket: Ticket = await ctx.runMutation(internal.campaignSend.reserveOne, { orgId: mail.orgId, to: mail.to });
  if (ticket.status !== "ok") return ticket;
  const replyTo = mail.replyTo ?? ticket.replyTo;
  const result = await resendPost({ from: ticket.from, to: [ticket.address], subject: mail.subject, text: `${mail.text.trimEnd()}\n\n--\n${ticket.postalAddress}`, ...(replyTo ? { reply_to: replyTo } : {}) }, mail.idempotencyKey ?? crypto.randomUUID());
  if (result.ok) return { status: "sent" as const, id: result.id };
  if (!result.unknown) await ctx.runMutation(internal.campaignSend.releaseOne, { orgId: mail.orgId, day: ticket.day });
  return { status: "failed" as const, reason: result.reason, ...(result.unknown ? { unknown: true } : {}) };
}
export const transactional = internalAction({ args: { orgId: v.id("orgs"), to: v.string(), subject: v.string(), text: v.string(), replyTo: v.optional(v.string()), idempotencyKey: v.optional(v.string()) }, handler: (ctx, args): Promise<Transactional> => sendTransactional(ctx, args) });
