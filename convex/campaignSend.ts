declare const process: { env: Record<string, string | undefined> };
import { v } from "convex/values";
import { httpAction, internalAction, internalMutation, internalQuery, type ActionCtx, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { MAX_ATTEMPTS, addNote, audience, exclusion, logActivity, recipientOf, release, reserve, setStatus, standardItem, stateOf, suppress } from "./lib/campaign";
import { addressIn, compose, fromHeader, inboundDomain, normalAddress, replyPart, resendPost, settingsProblems, validAddress, verifySvix } from "./lib/campaignText";

// The campaign sender. Every minute a tick claims a bounded batch in one mutation
// (rows created, daily counts reserved, each row leased), then sends each through
// Resend with the row id as Idempotency-Key. Before each send it checks again that
// the campaign is active and the email approved, so a pause or stop takes effect
// mid-batch. A lease that runs out (the action died) puts the row back in the queue;
// the same key then makes Resend answer with the first send instead of a second one.
const MINUTE = 60_000, LEASE = 5 * MINUTE, BATCH = 25, NEW_PER_RUN = 200;
const newToken = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
const valueOf = (record: Doc<"records">, field: Doc<"fields"> | undefined) => (field ? record.values[field._id] : undefined);

type Claimed = { sendId: Id<"emailSends">; attempt: number; mail: Record<string, unknown> };

// An email is sent once every recipient has an outcome; a follow-up also waits for
// the email before it and for every one of its recipients' waits to end.
async function settle(ctx: MutationCtx, emailId: Id<"records">, now: number) {
  const email = await ctx.db.get(emailId), item = email && await standardItem(ctx, email.orgId, "email");
  if (!email || !item?.f.status) return;
  const status = valueOf(email, item.f.status);
  if (status !== "approved" && status !== "sending") return;
  const rows = await ctx.db.query("emailSends").withIndex("by_email", (q) => q.eq("emailRecordId", email._id)).collect();
  if (rows.some((row) => row.status === "queued" || row.status === "sending")) return;
  const previousId = valueOf(email, item.f.followsUp) as Id<"records"> | undefined, previous = previousId ? await ctx.db.get(previousId) : null;
  if (previousId ? !previous || valueOf(previous, item.f.status) !== "sent" : !rows.length) return;
  const { candidates, waiting } = await audience(ctx, email.orgId, email, item, now, 1);
  if (!candidates.length && !waiting) await setStatus(ctx, email, item, "sent");
}

async function claimFor(ctx: MutationCtx, run: Doc<"emailRuns">, now: number, room: number): Promise<Claimed[]> {
  const email = await ctx.db.get(run.emailRecordId);
  if (!email) { await ctx.db.patch(run._id, { live: false }); return []; }
  const state = await stateOf(ctx, email, now), person = await standardItem(ctx, email.orgId, "person");
  if (!state || state.problems.length || !state.campaign || !person) return [];
  const { org, item, campaign } = state, settings = org.emailSettings!, inbound = inboundDomain();
  const { candidates } = await audience(ctx, org._id, email, item, now, NEW_PER_RUN);
  for (const c of candidates) {
    // A reply Gmail sync found counts on the send it answered.
    if (c.replied) await ctx.db.patch(c.replied, { repliedAt: now });
    await ctx.db.insert("emailSends", { orgId: org._id, emailRecordId: email._id, campaignRecordId: campaign._id, personRecordId: c.personId, to: c.address ?? "", token: newToken(), status: c.reason ? "skipped" : "queued", ...(c.reason ? { skipReason: c.reason } : {}), attempts: 0 });
  }
  const template = { subject: String(valueOf(email, item.f.subject) ?? ""), body: String(valueOf(email, item.f.body) ?? "") }, out: Claimed[] = [];
  for (const send of await ctx.db.query("emailSends").withIndex("by_email_status", (q) => q.eq("emailRecordId", email._id).eq("status", "queued")).take(room)) {
    if (send.attempts >= MAX_ATTEMPTS) { await ctx.db.patch(send._id, { status: "failed", failReason: send.failReason ?? `Gave up after ${MAX_ATTEMPTS} attempts` }); continue; }
    const reason = await exclusion(ctx, org._id, send.to);
    if (reason) { await ctx.db.patch(send._id, { status: "skipped", skipReason: reason }); continue; }
    const day = await reserve(ctx, org._id, settings.dailyLimit ?? 0, now);
    if (day === null) break;
    const record = await ctx.db.get(send.personRecordId), recipient: { name: string; company?: string } = record ? await recipientOf(ctx, person, record) : { name: "" };
    const message = compose(template, { name: recipient.name, company: recipient.company, token: send.token }, settings.postalAddress!, send.token);
    const replyTo = inbound ? `r-${send.token}@${inbound}` : state.replyTo!;
    await ctx.db.patch(send._id, { status: "sending", lease: now + LEASE, attempts: send.attempts + 1, reservedDay: day, subject: message.subject });
    out.push({ sendId: send._id, attempt: send.attempts + 1, mail: { from: fromHeader(settings.fromName, settings.fromAddress!), to: [send.to], subject: message.subject, text: message.text, html: message.html, headers: message.headers, reply_to: replyTo, tags: [{ name: "send", value: send._id }] } });
  }
  if (out.length && valueOf(email, item.f.status) === "approved") await setStatus(ctx, email, item, "sending");
  await settle(ctx, email._id, now);
  return out;
}

export const claim = internalMutation({ args: {}, handler: async (ctx) => {
  const now = Date.now();
  for (const send of await ctx.db.query("emailSends").withIndex("by_status_lease", (q) => q.eq("status", "sending").lt("lease", now)).take(100)) {
    await release(ctx, send.orgId, send.reservedDay);
    await ctx.db.patch(send._id, { status: "queued", lease: undefined, reservedDay: undefined });
  }
  const out: Claimed[] = [];
  for (const run of await ctx.db.query("emailRuns").withIndex("by_live", (q) => q.eq("live", true)).take(100)) {
    if (out.length >= BATCH) break;
    out.push(...(await claimFor(ctx, run, now, BATCH - out.length)));
  }
  return out;
} });

// The last check before one send: still allowed, still this attempt. If not, the row
// goes back to the queue (or is skipped for a new unsubscribe) and its count is released.
export const begin = internalMutation({ args: { sendId: v.id("emailSends"), attempt: v.number() }, handler: async (ctx, { sendId, attempt }) => {
  const send = await ctx.db.get(sendId);
  if (!send || send.status !== "sending" || send.attempts !== attempt) return false;
  const email = await ctx.db.get(send.emailRecordId), state = email ? await stateOf(ctx, email, Date.now()) : null, reason = await exclusion(ctx, send.orgId, send.to);
  if (state && !state.problems.length && !reason) return true;
  await release(ctx, send.orgId, send.reservedDay);
  await ctx.db.patch(send._id, reason ? { status: "skipped", skipReason: reason, lease: undefined, reservedDay: undefined } : { status: "queued", attempts: send.attempts - 1, lease: undefined, reservedDay: undefined });
  return false;
} });

const outcome = v.union(v.object({ ok: v.literal(true), id: v.string() }), v.object({ ok: v.literal(false), retry: v.boolean(), reason: v.string() }));
export const finish = internalMutation({ args: { sendId: v.id("emailSends"), attempt: v.number(), outcome }, handler: async (ctx, { sendId, attempt, outcome }) => {
  const send = await ctx.db.get(sendId);
  if (!send || send.status !== "sending" || send.attempts !== attempt) return;
  if (outcome.ok) {
    await ctx.db.patch(send._id, { status: "sent", providerId: outcome.id, sentAt: Date.now(), lease: undefined });
    await logActivity(ctx, send.orgId, send.personRecordId, `Sent: ${send.subject ?? ""}`);
  } else {
    await release(ctx, send.orgId, send.reservedDay);
    await ctx.db.patch(send._id, { status: outcome.retry && send.attempts < MAX_ATTEMPTS ? "queued" : "failed", failReason: outcome.reason, lease: undefined, reservedDay: undefined });
  }
  await settle(ctx, send.emailRecordId, Date.now());
} });

export const tick = internalAction({ args: {}, handler: async (ctx) => {
  const claimed: Claimed[] = await ctx.runMutation(internal.campaignSend.claim, {});
  let sent = 0;
  for (const item of claimed) {
    if (!(await ctx.runMutation(internal.campaignSend.begin, { sendId: item.sendId, attempt: item.attempt }))) continue;
    const result = await resendPost(item.mail, item.sendId);
    await ctx.runMutation(internal.campaignSend.finish, { sendId: item.sendId, attempt: item.attempt, outcome: result });
    if (result.ok) sent++;
  }
  return { claimed: claimed.length, sent };
} });

// Webhooks: each Svix id is applied once.
async function firstTime(ctx: MutationCtx, eventId: string) {
  if (await ctx.db.query("webhookEvents").withIndex("by_event", (q) => q.eq("provider", "resend").eq("eventId", eventId)).unique()) return false;
  await ctx.db.insert("webhookEvents", { provider: "resend", eventId, at: Date.now() });
  return true;
}
export const seen = internalQuery({ args: { eventId: v.string() }, handler: async (ctx, { eventId }) => !!(await ctx.db.query("webhookEvents").withIndex("by_event", (q) => q.eq("provider", "resend").eq("eventId", eventId)).unique()) });

export const track = internalMutation({ args: { eventId: v.string(), type: v.string(), providerId: v.optional(v.string()), tag: v.optional(v.string()), link: v.optional(v.string()), bounce: v.optional(v.string()) }, handler: async (ctx, a) => {
  if (!(await firstTime(ctx, a.eventId))) return;
  const tagged = a.tag ? ctx.db.normalizeId("emailSends", a.tag) : null;
  const send = (tagged && await ctx.db.get(tagged)) || (a.providerId ? await ctx.db.query("emailSends").withIndex("by_provider", (q) => q.eq("providerId", a.providerId)).first() : null);
  if (!send) return;
  const now = Date.now(), about = (what: string) => logActivity(ctx, send.orgId, send.personRecordId, `${what}: ${send.subject ?? ""}`);
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

// A reply to r-<token>@<inbound domain>: marked on its send, kept as a Note, and handed
// back for forwarding to the org's reply-to address so the person sees it in their inbox.
export const replied = internalMutation({ args: { eventId: v.string(), token: v.string(), from: v.string(), text: v.string() }, handler: async (ctx, a) => {
  if (!(await firstTime(ctx, a.eventId))) return null;
  const send = await ctx.db.query("emailSends").withIndex("by_token", (q) => q.eq("token", a.token)).unique();
  if (!send || send.status !== "sent") return null;
  if (!send.repliedAt) { await ctx.db.patch(send._id, { repliedAt: Date.now() }); await logActivity(ctx, send.orgId, send.personRecordId, `Replied: ${send.subject ?? ""}`); }
  await addNote(ctx, send.orgId, send.personRecordId, a.text);
  const email = await ctx.db.get(send.emailRecordId), state = email ? await stateOf(ctx, email, Date.now()) : null, settings = state?.org.emailSettings;
  const person = await ctx.db.get(send.personRecordId), blocked = settingsProblems(settings).some((p) => /API key|sender domain/.test(p));
  if (!state?.replyTo || !settings?.fromAddress || blocked) return null;
  return { from: fromHeader(settings.fromName, settings.fromAddress), to: [state.replyTo], ...(a.from ? { reply_to: a.from } : {}), subject: `Re: ${send.subject ?? ""}`, text: `${person?.title || a.from} replied to "${send.subject ?? ""}":\n\n${a.text || "(Remold could not read the reply text.)"}` };
} });

async function received(ctx: ActionCtx, eventId: string, data: Record<string, unknown>) {
  const domain = inboundDomain(), to = Array.isArray(data.to) ? data.to : [];
  const token = domain && to.map((address) => /^r-([a-f0-9]{32})@(.+)$/.exec(addressIn(String(address)) ?? "")).find((match) => match?.[2] === domain)?.[1];
  if (!token || await ctx.runQuery(internal.campaignSend.seen, { eventId })) return;
  let text = "";
  if (process.env.RESEND_API_KEY && typeof data.email_id === "string") {
    try {
      const response = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(data.email_id)}`, { redirect: "error", headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}` }, signal: AbortSignal.timeout(10_000) });
      const json = response.ok ? await response.json() as { text?: unknown } : {};
      if (typeof json.text === "string") text = json.text;
    } catch { /* The reply still counts; only its text is missing. */ }
  }
  const forward = await ctx.runMutation(internal.campaignSend.replied, { eventId, token, from: addressIn(String(data.from ?? "")) ?? "", text: replyPart(text).slice(0, 5000) });
  if (forward) await resendPost(forward, `forward-${eventId}`);
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
export type Transactional = Exclude<Ticket, { status: "ok" }> | { status: "sent"; id: string } | { status: "failed"; reason: string };
export async function sendTransactional(ctx: ActionCtx, mail: { orgId: Id<"orgs">; to: string; subject: string; text: string; replyTo?: string; idempotencyKey?: string }): Promise<Transactional> {
  const ticket: Ticket = await ctx.runMutation(internal.campaignSend.reserveOne, { orgId: mail.orgId, to: mail.to });
  if (ticket.status !== "ok") return ticket;
  const replyTo = mail.replyTo ?? ticket.replyTo;
  const result = await resendPost({ from: ticket.from, to: [ticket.address], subject: mail.subject, text: `${mail.text.trimEnd()}\n\n--\n${ticket.postalAddress}`, ...(replyTo ? { reply_to: replyTo } : {}) }, mail.idempotencyKey ?? crypto.randomUUID());
  if (result.ok) return { status: "sent" as const, id: result.id };
  await ctx.runMutation(internal.campaignSend.releaseOne, { orgId: mail.orgId, day: ticket.day });
  return { status: "failed" as const, reason: result.reason };
}
export const transactional = internalAction({ args: { orgId: v.id("orgs"), to: v.string(), subject: v.string(), text: v.string(), replyTo: v.optional(v.string()), idempotencyKey: v.optional(v.string()) }, handler: (ctx, args): Promise<Transactional> => sendTransactional(ctx, args) });
