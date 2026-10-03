import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { Actor, Principal } from "../identity";
import { fail } from "../errors";
import { UNKNOWN, badTags } from "./campaignText";

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const CONTENT = ["subject", "body", "campaign", "followsUp"];
// What an approval was given for: changing any of these afterwards withdraws it.
const WATCHED = [...CONTENT, "waitDays", "sendTo", "sendAt"];

// Whether an Email record may be sent as written. Every approval path reaches this
// through applyChange, so the app, an adopted suggestion and the API check the same things.
async function sendable(ctx: MutationCtx, f: Record<string, Doc<"fields">>, values: Record<string, unknown>, recordId?: Id<"records">) {
  const text = (key: string) => (typeof values[f[key]!._id] === "string" ? (values[f[key]!._id] as string).trim() : "");
  if (!text("subject")) fail("VALIDATION", "An email needs a subject", { fieldId: f.subject!._id });
  if (!text("body")) fail("VALIDATION", "An email needs a body", { fieldId: f.body!._id });
  for (const key of ["subject", "body"]) { const bad = badTags(text(key)); if (bad.length) fail("VALIDATION", `Unknown merge tag ${bad[0]}. Use {{firstName}}, {{name}} or {{company}}, with a fallback like {{firstName|there}}`, { fieldId: f[key]!._id }); }
  const campaign = values[f.campaign!._id];
  if (!campaign) fail("VALIDATION", "An email needs a campaign", { fieldId: f.campaign!._id });
  // A follow-up chain stays inside one campaign and never loops back on itself.
  let previous = values[f.followsUp!._id] as Id<"records"> | undefined;
  for (let depth = 0; previous; depth++) {
    const record = await ctx.db.get(previous);
    if (!record || previous === recordId || depth > 50 || record.values[f.campaign!._id] !== campaign) fail("VALIDATION", "A follow-up must follow an email in the same campaign", { fieldId: f.followsUp!._id });
    previous = record.values[f.followsUp!._id] as Id<"records"> | undefined;
  }
}

const fieldsByKey = (fields: Doc<"fields">[]) => Object.fromEntries(fields.filter((field) => !field.retired).map((field) => [field.key, field]));
const statuses = (f: Record<string, Doc<"fields">>, before: Record<string, unknown> | null, after: Record<string, unknown>) => { const was = before?.[f.status!._id], now = after[f.status!._id]; return { was, now, entering: now === "approved" && was !== "approved", live: now === "approved" || now === "sending" }; };

// Runs inside applyChange before an Email record is written, so a refusal leaves nothing
// behind even for a caller that catches it (CSV import). Only an admin approves;
// Sending and Sent are the campaign sender's to set (actor "Campaign email"), never an
// automation record's; approval checks the content.
export async function emailCheck(ctx: MutationCtx, principal: Principal, actor: Actor, object: Doc<"objects">, fields: Doc<"fields">[], before: Record<string, unknown> | null, after: Record<string, unknown>, recordId?: Id<"records">) {
  if (!object.isStandard || object.key !== "email") return;
  const f = fieldsByKey(fields);
  if (!f.status) return;
  const { was, now, entering } = statuses(f, before, after), engine = actor.kind === "automation" && actor.id === "Campaign email";
  if ((now === "sending" || now === "sent") && was !== now && !engine) fail("VALIDATION", "Remold sets Sending and Sent itself", { fieldId: f.status._id });
  if (!entering) return;
  if (!engine && (!("member" in principal) || principal.member.role === "member")) fail("FORBIDDEN", "Only an admin can approve an email");
  if (CONTENT.some((key) => !f[key])) fail("VALIDATION", "This email is missing a standard field, so it cannot be sent");
  await sendable(ctx, f, after, recordId);
}

// Runs after the write. The emailRuns row is what the sender reads: it follows the
// record's status. Any change to what goes out, or to whom, after approval withdraws
// the approval: the caller (applyChange) then sets the email back to draft. A withdrawn
// or deleted approval drops the people it had queued, so the next approval decides afresh.
export async function emailRules(ctx: MutationCtx, principal: Principal, object: Doc<"objects">, fields: Doc<"fields">[], before: Record<string, unknown> | null, after: Record<string, unknown> | null, recordId: Id<"records">): Promise<"withdraw" | undefined> {
  if (!object.isStandard || object.key !== "email") return;
  const f = fieldsByKey(fields);
  const run = await ctx.db.query("emailRuns").withIndex("by_email", (q) => q.eq("emailRecordId", recordId)).unique();
  // A queued row whose last try had no answer may already have gone out: it is failed as
  // unknown (never sent again, still counted, still in the recipient set) rather than deleted.
  const settleQueue = async (all: boolean) => {
    for (const row of await ctx.db.query("emailSends").withIndex("by_email_status", (q) => q.eq("emailRecordId", recordId).eq("status", "queued")).collect()) {
      if (row.uncertain) await ctx.db.patch(row._id, { status: "failed", failReason: UNKNOWN });
      else if (all) await ctx.db.delete(row._id);
    }
  };
  const drop = async () => {
    if (run) await ctx.db.delete(run._id);
    await settleQueue(true);
  };
  if (!after) { await drop(); return; }
  if (!f.status) return;
  const { now, entering, live } = statuses(f, before, after);
  if (entering && "member" in principal) {
    const approval = { approvedBy: principal.user._id, approvedAt: Date.now(), confirmed: false, live: true };
    if (run) await ctx.db.patch(run._id, approval); else await ctx.db.insert("emailRuns", { orgId: object.orgId, emailRecordId: recordId, ...approval });
    return;
  }
  if (live && !entering && WATCHED.some((key) => f[key] && !same(before?.[f[key]._id], after[f[key]._id]))) return "withdraw";
  if (run && !live) {
    if (now === "stopped") await settleQueue(false);
    if (now === "sent" || now === "stopped") await ctx.db.patch(run._id, { live: false });
    else await drop();
  }
}
