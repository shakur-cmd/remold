import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { ownerOf, type Actor, type Principal } from "../identity";
import { fail } from "../errors";
import { writable } from "../authority/readonly";
import { canReadField, canReadObject, canReadRecord, requireRecordRead, visibleTitle } from "../authority/reads";
import { applyChange } from "./applyChange";
import { DAY, compose, deploymentCap, fingerprint, inboundDomain, normalAddress, settingsProblems, validAddress, type EmailSettings, type Recipient } from "./campaignText";

type Ctx = QueryCtx | MutationCtx;
export type Item = { object: Doc<"objects">; f: Record<string, Doc<"fields">> };
export const AUTOMATION: Actor = { kind: "automation", id: "Campaign email" };
export const MAX_ATTEMPTS = 3;
// People added to an email's recipient set per approval. More than this need another approval.
export const SNAPSHOT_LIMIT = 4000;

export async function standardItem(ctx: Ctx, orgId: Id<"orgs">, key: string): Promise<Item | null> {
  const object = await ctx.db.query("objects").withIndex("by_org_key", (q) => q.eq("orgId", orgId).eq("key", key)).unique();
  if (!object?.isStandard) return null;
  const fields = await ctx.db.query("fields").withIndex("by_object", (q) => q.eq("orgId", orgId).eq("objectId", object._id)).collect();
  return { object, f: Object.fromEntries(fields.filter((field) => !field.retired).map((field) => [field.key, field])) };
}
export const value = (record: Doc<"records">, field: Doc<"fields"> | undefined) => (field ? record.values[field._id] : undefined);
const addressOf = (raw: unknown) => (typeof raw === "string" && raw.trim() ? normalAddress(raw) : null);

// Who a person is to merge tags: their name and their company's name.
export async function recipientOf(ctx: Ctx, person: Item, record: Doc<"records">): Promise<Recipient> {
  const companyId = value(record, person.f.company) as Id<"records"> | undefined, company = companyId ? await ctx.db.get(companyId) : null;
  return { name: record.title, company: company?.title || undefined };
}
// The same, as far as a caller may read the person's name and company.
async function visibleRecipient(ctx: Ctx, principal: Principal, person: Item, record: Doc<"records">): Promise<Recipient> {
  const readable = (key: string) => !!person.f[key] && canReadField(principal, person.object, person.f[key]!, record._id);
  const companyId = readable("company") ? (value(record, person.f.company) as Id<"records"> | undefined) : undefined, company = companyId ? await ctx.db.get(companyId) : null;
  return { name: readable("name") ? record.title : "", company: company ? (await visibleTitle(ctx, principal, company)) || undefined : undefined };
}

// Why an address may not get this campaign's email, or null. Unsubscribes, bounces and
// complaints (in `consent`, or on any earlier send) hold across the org; a reply only
// within the campaign it answered.
export async function exclusion(ctx: Ctx, orgId: Id<"orgs">, address: string, campaignId?: Id<"records">) {
  const consent = await ctx.db.query("consent").withIndex("by_recipient", (q) => q.eq("orgId", orgId).eq("recipient", address).eq("channel", "email").eq("purpose", "marketing")).order("desc").first();
  if (consent?.suppressed) return ({ bounce: "bounced", complaint: "complained", unsubscribe: "unsubscribed" } as Record<string, string>)[consent.source] ?? "suppressed";
  const past = await ctx.db.query("emailSends").withIndex("by_org_to", (q) => q.eq("orgId", orgId).eq("to", address)).collect();
  for (const [key, reason] of [["bouncedAt", "bounced"], ["complainedAt", "complained"], ["unsubscribedAt", "unsubscribed"]] as const) if (past.some((send) => send[key])) return reason;
  if (campaignId && past.some((send) => send.repliedAt && send.campaignRecordId === campaignId)) return "replied";
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

// Whether one recipient is left out at send time: a reply to the email before (or a
// Gmail-synced message after it), then the exclusions, then the follow-up's Send To.
export async function decide(ctx: Ctx, orgId: Id<"orgs">, campaignId: Id<"records">, address: string, previous: Doc<"emailSends"> | null, sendTo: string) {
  const wrote = !!previous && !previous.repliedAt && await wroteBack(ctx, orgId, previous.personRecordId, previous.sentAt ?? 0);
  if (previous?.repliedAt || wrote) return { reason: "replied", wrote };
  const excluded = await exclusion(ctx, orgId, address, campaignId);
  if (excluded) return { reason: excluded, wrote };
  if (previous && sendTo === "notOpened" && previous.openedAt) return { reason: "opened", wrote };
  if (previous && sendTo === "notClicked" && previous.clickedAt) return { reason: "clicked", wrote };
  return { reason: undefined, wrote };
}
const timing = (email: Doc<"records">, item: Item) => ({ wait: ((value(email, item.f.waitDays) as number | undefined) ?? 3) * DAY, sendTo: (value(email, item.f.sendTo) as string | undefined) ?? "notReplied" });

export type Candidate = { personId: Id<"records">; address: string | null; reason?: string };
// What a person approves: the words, schedule and follow-up rules, and the sender
// settings they go out with. The sender refuses to send if this changes after approval.
export function contentVersion(email: Doc<"records">, item: Item, settings: EmailSettings | undefined) {
  return fingerprint({ content: ["subject", "body", "campaign", "followsUp", "waitDays", "sendTo", "sendAt"].map((key) => value(email, item.f[key]) ?? null), from: [settings?.fromName ?? null, settings?.fromAddress ?? null, settings?.replyTo ?? null, settings?.postalAddress ?? null] });
}
// The same plus exactly who it goes to; a preview shows it and approval must match it.
export const approvalVersion = (content: string, people: Candidate[]) => fingerprint({ content, people: people.map((c) => [c.personId, c.address, c.reason ?? null]) });

// A first email's people who have no row for it yet: from the campaign's People,
// each with an address or the reason it has none. Existing rows supply the addresses
// already taken, so nobody with a row is read again.
export async function newPeople(ctx: Ctx, email: Doc<"records">, item: Item, limit: number) {
  const person = await standardItem(ctx, email.orgId, "person"), campaignItem = await standardItem(ctx, email.orgId, "campaign");
  const campaignId = value(email, item.f.campaign) as Id<"records"> | undefined, campaign = campaignId ? await ctx.db.get(campaignId) : null;
  if (!person || !campaignItem || !campaign) return [];
  const rows = await ctx.db.query("emailSends").withIndex("by_email", (q) => q.eq("emailRecordId", email._id)).collect();
  const had = new Set(rows.map((row) => row.personRecordId as string)), seen = new Set(rows.map((row) => row.to).filter(Boolean));
  const out: Candidate[] = [];
  for (const id of (value(campaign, campaignItem.f.people) as Id<"records">[] | undefined) ?? []) {
    if (out.length >= limit) break;
    if (had.has(id)) continue;
    const record = await ctx.db.get(id);
    if (!record) continue;
    const address = addressOf(value(record, person.f.email));
    const reason = !address ? "no email" : !validAddress(address) ? "invalid address" : seen.has(address) ? "duplicate address" : (await exclusion(ctx, email.orgId, address, campaign._id)) ?? undefined;
    if (address) seen.add(address);
    out.push({ personId: id, address, ...(reason ? { reason } : {}) });
  }
  return out;
}
// How many of a first email's campaign People are not in its recipient set yet (no reads per person).
async function notInSet(ctx: Ctx, email: Doc<"records">, item: Item, rows: Doc<"emailSends">[]) {
  if (value(email, item.f.followsUp)) return 0;
  const campaignItem = await standardItem(ctx, email.orgId, "campaign"), campaign = await ctx.db.get(value(email, item.f.campaign) as Id<"records">);
  const had = new Set(rows.map((row) => row.personRecordId as string));
  return campaign && campaignItem ? new Set(((value(campaign, campaignItem.f.people) as string[] | undefined) ?? []).filter((id) => !had.has(id))).size : 0;
}

// The approval fixes who an email goes to. A first email: the campaign's People now,
// as queued rows (or skipped, with the reason). A follow-up: one row per person the
// email before was sent to, due after the wait; more are added as that email goes out.
export async function snapshot(ctx: MutationCtx, email: Doc<"records">, item: Item, people: Candidate[]) {
  const campaignId = value(email, item.f.campaign) as Id<"records">, previous = value(email, item.f.followsUp) as Id<"records"> | undefined;
  const base = { orgId: email.orgId, emailRecordId: email._id, campaignRecordId: campaignId, attempts: 0 };
  if (!previous) {
    const notBefore = (value(email, item.f.sendAt) as number | undefined) ?? 0;
    for (const c of people) await ctx.db.insert("emailSends", { ...base, personRecordId: c.personId, to: c.address ?? "", token: newToken(), notBefore, ...(c.reason ? { status: "skipped" as const, skipReason: c.reason } : { status: "queued" as const }) });
    return;
  }
  for (const before of await ctx.db.query("emailSends").withIndex("by_email_status", (q) => q.eq("emailRecordId", previous).eq("status", "sent")).take(SNAPSHOT_LIMIT)) await followUpRow(ctx, email, item, before);
}
async function followUpRow(ctx: MutationCtx, email: Doc<"records">, item: Item, before: Doc<"emailSends">) {
  if (await ctx.db.query("emailSends").withIndex("by_email", (q) => q.eq("emailRecordId", email._id).eq("personRecordId", before.personRecordId)).first()) return;
  await ctx.db.insert("emailSends", { orgId: email.orgId, emailRecordId: email._id, campaignRecordId: value(email, item.f.campaign) as Id<"records">, personRecordId: before.personRecordId, to: before.to, token: newToken(), status: "queued", attempts: 0, notBefore: (before.sentAt ?? 0) + timing(email, item).wait, previousSendId: before._id });
}
// A send just went out: every approved follow-up of its email gets this person.
export async function followUpsOf(ctx: MutationCtx, send: Doc<"emailSends">) {
  const item = await standardItem(ctx, send.orgId, "email"), slot = item?.f.followsUp?.slot;
  if (!item || !slot) return;
  const name = `${slot.kind}${slot.index}`;
  const next: Doc<"records">[] = await (ctx.db.query("records") as any).withIndex(`by_${name}`, (q: any) => q.eq("orgId", send.orgId).eq("objectId", item.object._id).eq(name, send.emailRecordId)).collect();
  for (const email of next) {
    const run = await ctx.db.query("emailRuns").withIndex("by_email", (q) => q.eq("emailRecordId", email._id)).unique();
    if (run?.live && run.confirmed) await followUpRow(ctx, email, item, send);
  }
}
export const newToken = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");

export type State = { org: Doc<"orgs">; email: Doc<"records">; item: Item; campaign: Doc<"records"> | null; run: Doc<"emailRuns"> | null; replyTo?: string; problems: string[] };
export const NOT_CONFIRMED = "Not approved on the campaign page with the list confirmed";
export const CHANGED = "The email or the sending settings changed since approval";
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
  else if (!run?.confirmed) problems.push(NOT_CONFIRMED);
  else if (run.contentVersion !== contentVersion(email, item, org.emailSettings)) problems.push(CHANGED);
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
    const counts = { recipients: count((s) => s.status !== "skipped"), queued: count((s) => s.status === "queued" || s.status === "sending"), waiting: count((s) => s.status === "queued" && (s.notBefore ?? 0) > now), sent, failed: count((s) => s.status === "failed"), skipped: count((s) => s.status === "skipped"), delivered: count((s) => s.deliveredAt), opened: count((s) => s.openedAt), clicked: count((s) => s.clickedAt), replied: count((s) => s.repliedAt), bounced: count((s) => s.bouncedAt), unsubscribed: count((s) => s.unsubscribedAt) };
    const recipients = [];
    for (const s of rows) {
      const record = person ? await ctx.db.get(s.personRecordId) : null;
      if (!record || !person || !canReadRecord(principal, person.object, record)) continue;
      const address = person.f.email && canReadField(principal, person.object, person.f.email, record._id) ? s.to || null : null;
      recipients.push({ sendId: s._id, person: { id: record._id, ref: record.ref ?? null }, name: person.f.name && canReadField(principal, person.object, person.f.name, record._id) ? record.title : null, address, status: s.status, skipReason: s.skipReason ?? null, failReason: s.failReason ?? null, sentAt: s.sentAt ?? null, opened: !!s.openedAt, clicked: !!s.clickedAt, replied: !!s.repliedAt, bounced: !!s.bouncedAt, unsubscribed: !!s.unsubscribedAt });
    }
    const state = await stateOf(ctx, email, now), status = value(email, item.f.status);
    // People linked to the campaign after its approval: they get nothing until an admin approves again.
    const added = status === "approved" || status === "sending" || status === "sent" ? await notInSet(ctx, email, item, rows) : 0;
    return { id: email._id, ref: email.ref ?? null, subject: shown(email, "subject"), status: shown(email, "status"), followsUp: shown(email, "followsUp"), waitDays: shown(email, "waitDays"), sendTo: shown(email, "sendTo"), sendAt: shown(email, "sendAt"), problems: state?.problems ?? ["This email is missing a standard field"], added, counts, rates: { opened: share(counts.opened, sent), clicked: share(counts.clicked, sent), replied: share(counts.replied, sent) }, recipients };
  })) };
}

// The email as one person would get it, and who an approval now would add and who
// it leaves out and why. Names, companies and addresses follow the caller's read scope.
export async function emailPreview(ctx: Ctx, principal: Principal, email: Doc<"records">, personId?: Id<"records">) {
  const item = await standardItem(ctx, principal.org._id, "email"), person = await standardItem(ctx, principal.org._id, "person");
  if (!item || !person || email.objectId !== item.object._id) fail("NOT_FOUND", "Email not found");
  requireRecordRead(principal, item.object, email);
  const now = Date.now(), state = await stateOf(ctx, email, now);
  if (!state?.campaign) fail("VALIDATION", "This email has no campaign yet");
  const campaignObject = await ctx.db.get(state.campaign.objectId);
  if (!campaignObject || !canReadRecord(principal, campaignObject, state.campaign)) fail("NOT_FOUND", "Campaign not found");
  const previous = value(email, item.f.followsUp) as Id<"records"> | undefined;
  let candidates: Candidate[] = [], waiting = 0;
  if (!previous) candidates = await newPeople(ctx, email, item, SNAPSHOT_LIMIT);
  else {
    const { wait, sendTo } = timing(email, item), had = new Set((await ctx.db.query("emailSends").withIndex("by_email", (q) => q.eq("emailRecordId", email._id)).collect()).map((s) => s.personRecordId as string));
    for (const before of await ctx.db.query("emailSends").withIndex("by_email_status", (q) => q.eq("emailRecordId", previous).eq("status", "sent")).take(1000)) {
      if (had.has(before.personRecordId)) continue;
      if ((before.sentAt ?? 0) + wait > now) { waiting++; continue; }
      candidates.push({ personId: before.personRecordId, address: before.to, reason: (await decide(ctx, principal.org._id, state.campaign._id, before.to, before, sendTo)).reason });
    }
  }
  const listed = [];
  for (const c of candidates.slice(0, 200)) {
    const record = await ctx.db.get(c.personId);
    if (record && canReadRecord(principal, person.object, record)) listed.push({ c, record, row: { person: { id: record._id, ref: record.ref ?? null }, name: person.f.name && canReadField(principal, person.object, person.f.name, record._id) ? record.title : null, address: person.f.email && canReadField(principal, person.object, person.f.email, record._id) ? c.address : null, ...(c.reason ? { reason: c.reason } : {}) } });
  }
  let target = personId ? listed.find(({ c }) => c.personId === personId)?.record : listed.find(({ c }) => !c.reason)?.record;
  if (personId && !target) { const record = await ctx.db.get(personId); if (!record || record.orgId !== principal.org._id || !canReadRecord(principal, person.object, record)) fail("NOT_FOUND", "Person not found"); target = record; }
  // A caller who cannot read the subject or body sees neither, rendered or not.
  const readable = (key: string) => !!item.f[key] && canReadField(principal, item.object, item.f[key]!, email._id);
  const template = { subject: readable("subject") ? String(value(email, item.f.subject) ?? "") : "", body: readable("body") ? String(value(email, item.f.body) ?? "") : "" };
  const recipient = target ? await visibleRecipient(ctx, principal, person, target) : null;
  const rendered = recipient ? { person: { name: recipient.name || null }, ...compose(template, recipient, state.org.emailSettings?.postalAddress ?? "", "preview") } : null;
  // The version binds an approval to what this preview showed; only someone who could see all of it gets one.
  const whole = ["subject", "body", "campaign", "followsUp", "waitDays", "sendTo", "sendAt"].every((key) => !item.f[key] || readable(key)) && ["name", "email", "company"].every((key) => !person.f[key] || canReadField(principal, person.object, person.f[key]!)) && listed.length === Math.min(candidates.length, 200);
  const version = whole ? approvalVersion(contentVersion(email, item, state.org.emailSettings), previous ? [] : candidates) : null;
  return { version, rendered, recipients: listed.filter(({ c }) => !c.reason).map(({ row }) => row), excluded: listed.filter(({ c }) => c.reason).map(({ row }) => row), counts: { recipients: candidates.filter((c) => !c.reason).length, excluded: candidates.filter((c) => c.reason).length, waiting }, problems: state.problems };
}
