import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { ownerOf, type Actor, type Principal } from "../identity";
import { fail } from "../errors";
import { writable } from "../authority/readonly";
import { canReadField, canReadObject, canReadRecord, requireRecordRead } from "../authority/reads";
import { applyChange } from "./applyChange";
import { DAY, compose, deploymentCap, inboundDomain, normalAddress, settingsProblems, validAddress, type Recipient } from "./campaignText";

type Ctx = QueryCtx | MutationCtx;
export type Item = { object: Doc<"objects">; f: Record<string, Doc<"fields">> };
export const AUTOMATION: Actor = { kind: "automation", id: "Campaign email" };
export const MAX_ATTEMPTS = 3;

export async function standardItem(ctx: Ctx, orgId: Id<"orgs">, key: string): Promise<Item | null> {
  const object = await ctx.db.query("objects").withIndex("by_org_key", (q) => q.eq("orgId", orgId).eq("key", key)).unique();
  if (!object?.isStandard) return null;
  const fields = await ctx.db.query("fields").withIndex("by_object", (q) => q.eq("orgId", orgId).eq("objectId", object._id)).collect();
  return { object, f: Object.fromEntries(fields.filter((field) => !field.retired).map((field) => [field.key, field])) };
}
const value = (record: Doc<"records">, field: Doc<"fields"> | undefined) => (field ? record.values[field._id] : undefined);

// Who a person is to merge tags: their name and their company's name.
export async function recipientOf(ctx: Ctx, person: Item, record: Doc<"records">): Promise<Recipient & { address: string | null }> {
  const companyId = value(record, person.f.company) as Id<"records"> | undefined, company = companyId ? await ctx.db.get(companyId) : null;
  const raw = value(record, person.f.email);
  return { name: record.title, company: company?.title || undefined, address: typeof raw === "string" && raw.trim() ? normalAddress(raw) : null };
}

// Why an address may not get campaign email in this org, or null. Suppression in
// `consent` comes first; past replies, bounces, complaints and unsubscribes also count.
export async function exclusion(ctx: Ctx, orgId: Id<"orgs">, address: string) {
  const consent = await ctx.db.query("consent").withIndex("by_recipient", (q) => q.eq("orgId", orgId).eq("recipient", address).eq("channel", "email").eq("purpose", "marketing")).order("desc").first();
  if (consent?.suppressed) return ({ bounce: "bounced", complaint: "complained", unsubscribe: "unsubscribed" } as Record<string, string>)[consent.source] ?? "suppressed";
  const past = await ctx.db.query("emailSends").withIndex("by_org_to", (q) => q.eq("orgId", orgId).eq("to", address)).collect();
  for (const [key, reason] of [["repliedAt", "replied"], ["bouncedAt", "bounced"], ["complainedAt", "complained"], ["unsubscribedAt", "unsubscribed"]] as const) if (past.some((send) => send[key])) return reason;
  return null;
}

// Without an inbound domain, a reply shows up as an "Email received" Activity from Gmail sync.
async function wroteBack(ctx: Ctx, orgId: Id<"orgs">, personId: Id<"records">, since: number) {
  const activity = await standardItem(ctx, orgId, "activity"), about = activity?.f.about;
  if (!activity || !about?.slot) return false;
  const slot = `${about.slot.kind}${about.slot.index}`;
  const rows: Doc<"records">[] = await (ctx.db.query("records") as any).withIndex(`by_${slot}`, (q: any) => q.eq("orgId", orgId).eq("objectId", activity.object._id).eq(slot, personId)).collect();
  return rows.some((row) => value(row, activity.f.type) === "email" && /received/i.test(row.title) && ((value(row, activity.f.when) as number | undefined) ?? row._creationTime) > since);
}

export type Candidate = { personId: Id<"records">; recipient: Recipient; address: string | null; reason?: string; replied?: Id<"emailSends"> };
// Who an email goes to now, and who is left out and why. Only people without a row
// for this email yet, at most `limit`. `waiting` counts follow-up recipients whose wait is not over.
export async function audience(ctx: Ctx, orgId: Id<"orgs">, email: Doc<"records">, item: Item, now: number, limit = Infinity) {
  const person = await standardItem(ctx, orgId, "person"), campaignItem = await standardItem(ctx, orgId, "campaign");
  const out: Candidate[] = [];
  let waiting = 0;
  if (!person || !campaignItem) return { candidates: out, waiting };
  const had = new Set((await ctx.db.query("emailSends").withIndex("by_email", (q) => q.eq("emailRecordId", email._id)).collect()).map((send) => send.personRecordId as string));
  const previous = value(email, item.f.followsUp) as Id<"records"> | undefined;
  const add = async (candidate: Candidate) => {
    if (!candidate.reason && candidate.address) candidate.reason = (await exclusion(ctx, orgId, candidate.address)) ?? undefined;
    out.push(candidate);
  };
  if (!previous) {
    const campaign = await ctx.db.get(value(email, item.f.campaign) as Id<"records">);
    const ids = campaign ? ((value(campaign, campaignItem.f.people) as Id<"records">[] | undefined) ?? []) : [];
    const seen = new Set<string>();
    for (const id of ids) {
      if (out.length >= limit) break;
      const record = await ctx.db.get(id), raw = record && value(record, person.f.email);
      if (!record) continue;
      // People who already have a row still claim their address, so a later duplicate is caught.
      if (had.has(id)) { if (typeof raw === "string") seen.add(normalAddress(raw)); continue; }
      const { address, ...recipient } = await recipientOf(ctx, person, record);
      const reason = !address ? "no email" : !validAddress(address) ? "invalid address" : seen.has(address) ? "duplicate address" : undefined;
      if (address) seen.add(address);
      await add({ personId: id, recipient, address, reason });
    }
    return { candidates: out, waiting };
  }
  const wait = ((value(email, item.f.waitDays) as number | undefined) ?? 3) * DAY, sendTo = (value(email, item.f.sendTo) as string | undefined) ?? "notReplied";
  for (const before of await ctx.db.query("emailSends").withIndex("by_email_status", (q) => q.eq("emailRecordId", previous).eq("status", "sent")).collect()) {
    if (out.length >= limit) break;
    if (had.has(before.personRecordId)) continue;
    if ((before.sentAt ?? 0) + wait > now) { waiting++; continue; }
    const record = await ctx.db.get(before.personRecordId);
    const recipient = record ? await recipientOf(ctx, person, record) : { name: "", address: null };
    const replied = !before.repliedAt && await wroteBack(ctx, orgId, before.personRecordId, before.sentAt ?? 0);
    const reason = before.repliedAt || replied ? "replied" : (await exclusion(ctx, orgId, before.to)) ?? (sendTo === "notOpened" && before.openedAt ? "opened" : sendTo === "notClicked" && before.clickedAt ? "clicked" : undefined);
    out.push({ personId: before.personRecordId, recipient: { name: recipient.name, company: recipient.company }, address: before.to, reason, ...(replied ? { replied: before._id } : {}) });
  }
  return { candidates: out, waiting };
}

export type State = { org: Doc<"orgs">; email: Doc<"records">; item: Item; campaign: Doc<"records"> | null; run: Doc<"emailRuns"> | null; replyTo?: string; problems: string[] };
// Everything that decides whether an email may send right now. Problems are plain
// sentences for people and agents; any problem means nothing sends.
export async function stateOf(ctx: Ctx, email: Doc<"records">, now: number): Promise<State | null> {
  const org = await ctx.db.get(email.orgId), item = await standardItem(ctx, email.orgId, "email"), campaignItem = await standardItem(ctx, email.orgId, "campaign");
  if (!org || !item?.f.status || !item.f.campaign || !item.f.subject || !item.f.body || !campaignItem) return null;
  const campaignId = value(email, item.f.campaign) as Id<"records"> | undefined, campaign = campaignId ? await ctx.db.get(campaignId) : null;
  const run = await ctx.db.query("emailRuns").withIndex("by_email", (q) => q.eq("emailRecordId", email._id)).unique();
  const approver = run ? await ctx.db.get(run.approvedBy) : null;
  const replyTo = org.emailSettings?.replyTo || approver?.email || undefined;
  const status = value(email, item.f.status), sendAt = value(email, item.f.sendAt) as number | undefined;
  const problems = settingsProblems(org.emailSettings);
  if (org.flags?.readonly) problems.push("The workspace is read only");
  if (!campaign) problems.push("No campaign");
  else if (value(campaign, campaignItem.f.status) !== "active") problems.push("The campaign is not active");
  if (status === "stopped") problems.push("Stopped");
  else if (status !== "approved" && status !== "sending" && status !== "sent") problems.push("Not approved yet");
  else if (!run?.confirmed) problems.push("Not approved on the campaign page with the list confirmed");
  if (!value(email, item.f.followsUp) && sendAt && sendAt > now) problems.push(`Waits until ${new Date(sendAt).toISOString().slice(0, 16).replace("T", " ")} UTC`);
  // Before approval the approving admin is not known yet; their email becomes the default.
  if (run && !inboundDomain() && !replyTo) problems.push("No reply-to address");
  return { org, email, item, campaign, run, replyTo, problems };
}

// Reserves one send against the org's and the deployment's count for this UTC day.
// Convex serializes these writes, so concurrent ticks cannot both take the last one.
export async function reserve(ctx: MutationCtx, orgId: Id<"orgs">, limit: number, now: number) {
  const day = Math.floor(now / DAY), keys = [[`${day}:${orgId}`, limit], [`${day}:all`, deploymentCap()]] as const;
  const rows = [];
  for (const [key, cap] of keys) {
    const row = await ctx.db.query("emailCaps").withIndex("by_key", (q) => q.eq("key", key)).unique();
    if ((row?.used ?? 0) >= cap) return null;
    rows.push({ key, row });
  }
  for (const { key, row } of rows) if (row) await ctx.db.patch(row._id, { used: row.used + 1 }); else await ctx.db.insert("emailCaps", { key, used: 1 });
  return day;
}
export async function release(ctx: MutationCtx, orgId: Id<"orgs">, day: number | undefined) {
  if (day === undefined) return;
  for (const key of [`${day}:${orgId}`, `${day}:all`]) { const row = await ctx.db.query("emailCaps").withIndex("by_key", (q) => q.eq("key", key)).unique(); if (row && row.used > 0) await ctx.db.patch(row._id, { used: row.used - 1 }); }
}

// A timeline entry about the person, written as the owner by the campaign sender
// (or, for "Mark replied", in the name of whoever marked it).
export async function logActivity(ctx: MutationCtx, orgId: Id<"orgs">, personId: Id<"records">, title: string, actor: Actor = AUTOMATION) {
  const org = await ctx.db.get(orgId), activity = await standardItem(ctx, orgId, "activity");
  if (!org || org.flags?.readonly || !activity?.f.title || !(await ctx.db.get(personId))) return;
  const values = Object.fromEntries(([["title", title], ["type", "email"], ["when", Date.now()], ["about", personId], ["source", "campaign"]] as const).filter(([key]) => activity.f[key]).map(([key, v]) => [activity.f[key]!._id, v]));
  await applyChange(ctx, await ownerOf(ctx, orgId), { action: "create", orgId, objectId: activity.object._id, values, reason: "Campaign email" }, { actor });
}
export async function addNote(ctx: MutationCtx, orgId: Id<"orgs">, personId: Id<"records">, body: string) {
  const org = await ctx.db.get(orgId), note = await standardItem(ctx, orgId, "note");
  if (!org || org.flags?.readonly || !note?.f.body || !note.f.about || !body.trim()) return;
  await applyChange(ctx, await ownerOf(ctx, orgId), { action: "create", orgId, objectId: note.object._id, values: { [note.f.body._id]: body.trim().slice(0, 5000), [note.f.about._id]: personId }, reason: "Reply to a campaign email" }, { actor: AUTOMATION });
}
export async function setStatus(ctx: MutationCtx, email: Doc<"records">, item: Item, status: string) {
  await applyChange(ctx, await ownerOf(ctx, email.orgId), { action: "update", orgId: email.orgId, recordId: email._id, values: { [item.f.status!._id]: status }, reason: "Campaign sending" }, { actor: AUTOMATION });
}
// Suppression is a new consent row, so the history of who asked for what stays.
export async function suppress(ctx: MutationCtx, orgId: Id<"orgs">, address: string, source: "bounce" | "complaint" | "unsubscribe") {
  const latest = await ctx.db.query("consent").withIndex("by_recipient", (q) => q.eq("orgId", orgId).eq("recipient", address).eq("channel", "email").eq("purpose", "marketing")).order("desc").first();
  if (!latest?.suppressed) await ctx.db.insert("consent", { orgId, recipient: address, channel: "email", purpose: "marketing", suppressed: true, source, version: (latest?.version ?? 0) + 1, at: Date.now() });
}

export async function markReplied(ctx: MutationCtx, principal: Principal, sendId: string) {
  await writable(ctx, principal.org._id);
  const id = ctx.db.normalizeId("emailSends", sendId), send = id ? await ctx.db.get(id) : null;
  const campaign = send && send.orgId === principal.org._id ? await ctx.db.get(send.campaignRecordId) : null, object = campaign ? await ctx.db.get(campaign.objectId) : null;
  if (!send || !campaign || !object || !canReadRecord(principal, object, campaign)) fail("NOT_FOUND", "Send not found");
  if (send.status !== "sent") fail("VALIDATION", "Only a sent email can be replied to");
  if (!send.repliedAt) { await ctx.db.patch(send._id, { repliedAt: Date.now() }); await logActivity(ctx, send.orgId, send.personRecordId, `Replied: ${send.subject ?? ""}`, principal.actor); }
  return { id: send._id, repliedAt: send.repliedAt ?? Date.now() };
}

// Chain order: first emails by creation, each followed by its follow-ups.
function chain(emails: Doc<"records">[], item: Item) {
  const sorted = [...emails].sort((a, b) => a._creationTime - b._creationTime), out: Doc<"records">[] = [], ids = new Set(sorted.map((e) => e._id as string));
  const visit = (parent: string | undefined) => { for (const e of sorted) { const prev = value(e, item.f.followsUp) as string | undefined; if ((parent ? prev === parent : !prev || !ids.has(prev)) && !out.includes(e)) { out.push(e); visit(e._id); } } };
  visit(undefined);
  return [...out, ...sorted.filter((e) => !out.includes(e))];
}
const share = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 1000 : 0);

// A campaign's emails with their numbers and what blocks them, and each recipient
// as far as the caller may read the person and their email address.
export async function campaignReport(ctx: Ctx, principal: Principal, campaign: Doc<"records">) {
  const campaignObject = await ctx.db.get(campaign.objectId);
  if (!campaignObject?.isStandard || campaignObject.key !== "campaign") fail("NOT_FOUND", "Campaign not found");
  requireRecordRead(principal, campaignObject, campaign);
  const item = await standardItem(ctx, principal.org._id, "email"), person = await standardItem(ctx, principal.org._id, "person");
  if (!item?.f.campaign?.slot || !canReadObject(principal, item.object)) return { campaign: { id: campaign._id, ref: campaign.ref ?? null, name: campaign.title }, emails: [] };
  const slot = `${item.f.campaign.slot.kind}${item.f.campaign.slot.index}`, now = Date.now();
  const emails: Doc<"records">[] = (await (ctx.db.query("records") as any).withIndex(`by_${slot}`, (q: any) => q.eq("orgId", principal.org._id).eq("objectId", item.object._id).eq(slot, campaign._id)).collect()).filter((e: Doc<"records">) => canReadRecord(principal, item.object, e));
  const shown = (record: Doc<"records">, key: string) => { const field = item.f[key]; return field && canReadField(principal, item.object, field, record._id) ? record.values[field._id] ?? null : null; };
  return { campaign: { id: campaign._id, ref: campaign.ref ?? null, name: campaign.title }, emails: await Promise.all(chain(emails, item).map(async (email) => {
    const rows = await ctx.db.query("emailSends").withIndex("by_email", (q) => q.eq("emailRecordId", email._id)).collect();
    const count = (test: (s: Doc<"emailSends">) => unknown) => rows.filter(test).length, sent = count((s) => s.status === "sent");
    const counts = { recipients: count((s) => s.status !== "skipped"), queued: count((s) => s.status === "queued" || s.status === "sending"), sent, failed: count((s) => s.status === "failed"), skipped: count((s) => s.status === "skipped"), delivered: count((s) => s.deliveredAt), opened: count((s) => s.openedAt), clicked: count((s) => s.clickedAt), replied: count((s) => s.repliedAt), bounced: count((s) => s.bouncedAt), unsubscribed: count((s) => s.unsubscribedAt) };
    const recipients = [];
    for (const s of rows) {
      const record = person ? await ctx.db.get(s.personRecordId) : null;
      if (!record || !person || !canReadRecord(principal, person.object, record)) continue;
      const address = person.f.email && canReadField(principal, person.object, person.f.email, record._id) ? s.to || null : null;
      recipients.push({ sendId: s._id, person: { id: record._id, ref: record.ref ?? null }, name: person.f.name && canReadField(principal, person.object, person.f.name, record._id) ? record.title : null, address, status: s.status, skipReason: s.skipReason ?? null, failReason: s.failReason ?? null, sentAt: s.sentAt ?? null, opened: !!s.openedAt, clicked: !!s.clickedAt, replied: !!s.repliedAt, bounced: !!s.bouncedAt, unsubscribed: !!s.unsubscribedAt });
    }
    const state = await stateOf(ctx, email, now);
    return { id: email._id, ref: email.ref ?? null, subject: shown(email, "subject"), status: shown(email, "status"), followsUp: shown(email, "followsUp"), waitDays: shown(email, "waitDays"), sendTo: shown(email, "sendTo"), sendAt: shown(email, "sendAt"), problems: state?.problems ?? ["This email is missing a standard field"], counts, rates: { opened: share(counts.opened, sent), clicked: share(counts.clicked, sent), replied: share(counts.replied, sent) }, recipients };
  })) };
}

// The email as one person would get it now, and who it would go to and who not.
export async function emailPreview(ctx: Ctx, principal: Principal, email: Doc<"records">, personId?: Id<"records">) {
  const item = await standardItem(ctx, principal.org._id, "email"), person = await standardItem(ctx, principal.org._id, "person");
  if (!item || !person || email.objectId !== item.object._id) fail("NOT_FOUND", "Email not found");
  requireRecordRead(principal, item.object, email);
  const state = await stateOf(ctx, email, Date.now());
  if (!state?.campaign) fail("VALIDATION", "This email has no campaign yet");
  const campaignObject = await ctx.db.get(state.campaign.objectId);
  if (!campaignObject || !canReadRecord(principal, campaignObject, state.campaign)) fail("NOT_FOUND", "Campaign not found");
  const { candidates, waiting } = await audience(ctx, principal.org._id, email, item, Date.now(), 1000);
  const readable = async (c: Candidate) => { const record = await ctx.db.get(c.personId); return !!record && canReadRecord(principal, person.object, record) ? record : null; };
  const listed = [];
  for (const c of candidates) { const record = await readable(c); if (record) listed.push({ c, row: { person: { id: record._id, ref: record.ref ?? null }, name: record.title, address: person.f.email && canReadField(principal, person.object, person.f.email, record._id) ? c.address : null, ...(c.reason ? { reason: c.reason } : {}) } }); }
  const chosen = personId ? listed.find(({ c }) => c.personId === personId) : listed.find(({ c }) => !c.reason);
  let target = chosen?.c.recipient;
  if (personId && !chosen) { const record = await ctx.db.get(personId); if (!record || record.orgId !== principal.org._id || !canReadRecord(principal, person.object, record)) fail("NOT_FOUND", "Person not found"); target = { name: record.title, company: (await recipientOf(ctx, person, record)).company }; }
  const template = { subject: String(value(email, item.f.subject) ?? ""), body: String(value(email, item.f.body) ?? "") };
  const rendered = target ? { person: { name: target.name }, ...compose(template, target, state.org.emailSettings?.postalAddress ?? "", "preview") } : null;
  return { rendered, recipients: listed.filter(({ c }) => !c.reason).map(({ row }) => row), excluded: listed.filter(({ c }) => c.reason).map(({ row }) => row), counts: { recipients: candidates.filter((c) => !c.reason).length, excluded: candidates.filter((c) => c.reason).length, waiting }, problems: state.problems };
}
