import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { Actor, Principal } from "../identity";
import { fail } from "../errors";
import { badTags } from "./campaignText";

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const CONTENT = ["subject", "body", "campaign", "followsUp"];

// Whether an Email record may be sent as written. Every approval path reaches this
// through applyChange, so the app, an adopted suggestion and the API check the same things.
async function sendable(ctx: MutationCtx, f: Record<string, Doc<"fields">>, values: Record<string, unknown>, recordId: Id<"records">) {
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

// Runs inside applyChange after an Email record is written (the transaction undoes the
// write if this refuses). Only an admin approves; Sending and Sent are the sender's to set
// (actor "Campaign email"), never an automation's.
// The emailRuns row is what the sender reads: it follows the record's status.
// Clearing a deleted campaign or email out of a live step skips the content check:
// the sender then finds no campaign and sends nothing.
export async function emailRules(ctx: MutationCtx, principal: Principal, actor: Actor, object: Doc<"objects">, fields: Doc<"fields">[], before: Record<string, unknown> | null, after: Record<string, unknown> | null, recordId: Id<"records">, clearing = false) {
  if (!object.isStandard || object.key !== "email") return;
  const f = Object.fromEntries(fields.filter((field) => !field.retired).map((field) => [field.key, field]));
  const run = await ctx.db.query("emailRuns").withIndex("by_email", (q) => q.eq("emailRecordId", recordId)).unique();
  if (!after) { if (run) await ctx.db.delete(run._id); return; }
  if (!f.status) return;
  const was = before?.[f.status._id], now = after[f.status._id], engine = actor.kind === "automation" && actor.id === "Campaign email";
  if ((now === "sending" || now === "sent") && was !== now && !engine) fail("VALIDATION", "Remold sets Sending and Sent itself", { fieldId: f.status._id });
  const entering = now === "approved" && was !== "approved", live = now === "approved" || now === "sending";
  if (entering && !engine && (!("member" in principal) || principal.member.role === "member")) fail("FORBIDDEN", "Only an admin can approve an email");
  if (entering || (live && !clearing && CONTENT.some((key) => f[key] && !same(before?.[f[key]._id], after[f[key]._id])))) {
    if (CONTENT.some((key) => !f[key])) fail("VALIDATION", "This email is missing a standard field, so it cannot be sent");
    await sendable(ctx, f, after, recordId);
  }
  if (entering && "member" in principal) {
    const approval = { approvedBy: principal.user._id, approvedAt: Date.now(), confirmed: false, live: true };
    if (run) await ctx.db.patch(run._id, approval); else await ctx.db.insert("emailRuns", { orgId: object.orgId, emailRecordId: recordId, ...approval });
  } else if (run && !live) {
    if (now === "sent" || now === "stopped") await ctx.db.patch(run._id, { live: false });
    else await ctx.db.delete(run._id);
  }
}
