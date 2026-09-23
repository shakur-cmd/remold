import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { Principal } from "../identity";
import { fail } from "../errors";
import { projections } from "./slots";
import { uniqueRef } from "./ref";

export type Change =
  | { action: "create"; orgId: Id<"orgs">; objectId: Id<"objects">; values: Record<string, unknown>; reason?: string }
  | { action: "update"; orgId: Id<"orgs">; recordId: Id<"records">; values: Record<string, unknown>; reason?: string }
  | { action: "delete"; orgId: Id<"orgs">; recordId: Id<"records">; reason?: string };
const empty = (value: unknown) => value === null || value === undefined;

async function fieldsFor(ctx: MutationCtx, orgId: Id<"orgs">, objectId: Id<"objects">) {
  return ctx.db.query("fields").withIndex("by_object", (q) => q.eq("orgId", orgId).eq("objectId", objectId)).collect();
}

async function validateValue(ctx: MutationCtx, field: Doc<"fields">, value: unknown, orgId: Id<"orgs">) {
  if (empty(value)) return undefined;
  const invalid = (message: string): never => fail("VALIDATION", message, { fieldId: field._id });
  if (field.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) invalid("Expected a finite number");
  if (field.type === "text" && typeof value !== "string") invalid("Expected text");
  if (field.type === "select" && (typeof value !== "string" || !field.options?.some((option) => option.id === value))) invalid("Invalid select option");
  if (field.type === "date" && (typeof value !== "number" || !Number.isInteger(value))) invalid("Expected a date timestamp");
  if (field.type === "boolean" && typeof value !== "boolean") invalid("Expected boolean");
  if (field.type === "lookup" || field.type === "links") {
    const ids = field.type === "links" ? value : [value];
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) invalid("Expected record id");
    for (const id of ids as string[]) {
      const recordId = ctx.db.normalizeId("records", id);
      const record = recordId && (await ctx.db.get(recordId));
      if (!record || record.orgId !== orgId || (field.targetObjectId && record.objectId !== field.targetObjectId)) invalid("Invalid related record");
    }
  }
  return value;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// Returns eventId null only when an update changed nothing, so no event is written.
// Lookups store the target id in `values`, not in `links`, so a delete has to
// find them by field: through the slot index when the lookup has one, else by
// reading the source object's records.
async function clearReferencesTo(ctx: MutationCtx, membership: Principal, orgId: Id<"orgs">, deleted: Doc<"records">) {
  const objects = await ctx.db.query("objects").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect();
  for (const source of objects) {
    const lookups = (await fieldsFor(ctx, orgId, source._id)).filter((field) => field.type === "lookup" && (!field.targetObjectId || field.targetObjectId === deleted.objectId));
    for (const field of lookups) {
      const slot = field.slot;
      const referrers: Doc<"records">[] = slot
        ? await (ctx.db.query("records") as any).withIndex(`by_${slot.kind}${slot.index}`, (q: any) => q.eq("orgId", orgId).eq("objectId", source._id).eq(`${slot.kind}${slot.index}`, deleted._id)).collect()
        : (await ctx.db.query("records").withIndex("by_object", (q) => q.eq("orgId", orgId).eq("objectId", source._id)).collect()).filter((record) => record.values[field._id] === deleted._id);
      for (const record of referrers) {
        if (record._id === deleted._id) continue;
        await applyChange(ctx, membership, { action: "update", orgId, recordId: record._id, values: { [field._id]: null }, reason: `Linked ${deleted.title || "record"} was deleted` }, { clearingReference: true });
      }
    }
  }
}

export async function applyChange(ctx: MutationCtx, membership: Principal, change: Change, options: { clearingReference?: boolean; suggestionId?: Id<"suggestions"> } = {}): Promise<{ recordId: Id<"records">; eventId: Id<"events"> | null }> {
  let record: Doc<"records"> | null = null;
  let object: Doc<"objects"> | null;
  if (change.action === "create") object = await ctx.db.get(change.objectId);
  else { record = await ctx.db.get(change.recordId); object = record ? await ctx.db.get(record.objectId) : null; }
  if (!object || object.orgId !== change.orgId || (record && record.orgId !== change.orgId)) fail("NOT_FOUND", "Record or object not found");
  const fields = await fieldsFor(ctx, change.orgId, object._id);
  if (change.action === "delete") {
    // Records that link to this one drop it from their links value through an
    // attributed update, which also removes the rows; then this record's own rows go.
    const targets = await ctx.db.query("links").withIndex("by_target_any", (q) => q.eq("orgId", change.orgId).eq("toRecordId", record!._id)).collect();
    for (const row of targets) {
      if (row.fromRecordId === record!._id) continue;
      const source = await ctx.db.get(row.fromRecordId);
      const current = (source?.values[row.fieldId] as string[] | undefined) ?? [];
      if (source) await applyChange(ctx, membership, { action: "update", orgId: change.orgId, recordId: source._id, values: { [row.fieldId]: current.filter((id) => id !== record!._id) }, reason: `Linked ${record!.title || "record"} was deleted` }, { clearingReference: true });
    }
    const rows = await ctx.db.query("links").withIndex("by_record_any", (q) => q.eq("orgId", change.orgId).eq("fromRecordId", record!._id)).collect();
    for (const row of rows) await ctx.db.delete(row._id);
    await ctx.db.delete(record!._id);
    await clearReferencesTo(ctx, membership, change.orgId, record!);
    const eventId = await ctx.db.insert("events", { orgId: change.orgId, actor: membership.actor, action: "delete", objectId: object._id, recordId: record!._id, before: record!.values, after: null, reason: change.reason, suggestionId: options.suggestionId });
    return { recordId: record!._id, eventId };
  }
  const byId = new Map(fields.map((field) => [field._id, field]));
  const validated: Record<string, unknown> = {};
  for (const [fieldId, value] of Object.entries(change.values)) {
    const field = byId.get(fieldId as Id<"fields">);
    if (!field || field.retired) fail("VALIDATION", "Unknown or retired field", { fieldId });
    validated[fieldId] = await validateValue(ctx, field, value, change.orgId);
  }
  const values: Record<string, unknown> = change.action === "create" ? {} : { ...record!.values };
  for (const [fieldId, value] of Object.entries(validated)) { if (empty(value)) delete values[fieldId]; else values[fieldId] = value; }
  // An update only checks the fields it touches, so adding a required field
  // later does not lock every older record. Clearing references on delete may
  // empty a required lookup; a dangling id would be worse.
  for (const field of fields) {
    const checked = change.action === "create" || (field._id in validated && !options.clearingReference);
    if (checked && field.required && empty(values[field._id])) fail("VALIDATION", "Required field is empty", { fieldId: field._id });
  }
  const titleValue = object.titleFieldId ? values[object.titleFieldId] : undefined;
  let title = titleValue == null ? "" : String(titleValue);
  const titleField = object.titleFieldId ? byId.get(object.titleFieldId) : undefined;
  if (titleField?.type === "lookup" && typeof titleValue === "string") title = (await ctx.db.get(titleValue as Id<"records">))?.title ?? "";
  const changedIds = Object.keys(change.action === "create" ? values : validated).filter((fieldId) => change.action === "create" || !same(record!.values[fieldId], values[fieldId]));
  if (change.action === "update" && changedIds.length === 0) return { recordId: record!._id, eventId: null };
  const patch = { values, title, updatedAt: Date.now(), ...projections(fields, values) };
  const recordId = record ? record._id : await ctx.db.insert("records", { orgId: change.orgId, objectId: object._id, createdBy: "user" in membership ? membership.user._id : membership.agent._id, ref: await uniqueRef(ctx, change.orgId), ...patch });
  if (record) await ctx.db.patch(recordId, patch);
  for (const field of fields) {
    if (field.type !== "links") continue;
    if (!(field._id in validated)) continue;
    const existing = await ctx.db.query("links").withIndex("by_from", (q) => q.eq("orgId", change.orgId).eq("fieldId", field._id).eq("fromRecordId", recordId)).collect();
    const wanted = new Set((values[field._id] as string[] | undefined) ?? []);
    for (const row of existing) if (!wanted.delete(row.toRecordId)) await ctx.db.delete(row._id);
    for (const toRecordId of wanted) await ctx.db.insert("links", { orgId: change.orgId, fieldId: field._id, fromRecordId: recordId, toRecordId: toRecordId as Id<"records"> });
  }
  const before = Object.fromEntries(changedIds.map((fieldId) => [fieldId, record?.values[fieldId] ?? null]));
  const after = Object.fromEntries(changedIds.map((fieldId) => [fieldId, values[fieldId] ?? null]));
  const eventId = await ctx.db.insert("events", { orgId: change.orgId, actor: membership.actor, action: change.action, objectId: object._id, recordId, before: change.action === "create" ? null : before, after, reason: change.reason, suggestionId: options.suggestionId });
  return { recordId, eventId };
}
