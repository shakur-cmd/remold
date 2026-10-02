import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { ConvexError, v } from "convex/values";
import { fail } from "./errors";
import { ownerOf, type Membership } from "./identity";
import { writable } from "./authority/readonly";
import { applyChange } from "./lib/applyChange";
import { resolveValues, type Pending } from "./lib/values";
import { batchKey, checkBatch, type ImportRecord } from "./lib/importCheck";

// Operator import of drafted records (ops/import/records.mjs): the whole batch
// lands in one transaction or not at all, and a batch already imported is a no-op.
type Ctx = QueryCtx | MutationCtx;
type Item = { object: Doc<"objects">; fields: Doc<"fields">[] };
const args = { orgId: v.id("orgs"), batch: v.any() };

async function prepare(ctx: Ctx, orgId: Id<"orgs">, batch: unknown) {
  const { records, problems } = checkBatch(batch);
  if (problems.length) fail("VALIDATION", `Import refused:\n${problems.join("\n")}`);
  const principal = await ownerOf(ctx, orgId);
  await writable(ctx, orgId);
  const items = new Map<string, Item>();
  for (const key of new Set(records.map((record) => record.object))) {
    const object = await ctx.db.query("objects").withIndex("by_org_key", (q) => q.eq("orgId", orgId).eq("key", key)).unique();
    if (!object) fail("VALIDATION", `This workspace has no ${key} object; run seed:ensureStandard first`);
    items.set(key, { object, fields: await ctx.db.query("fields").withIndex("by_object", (q) => q.eq("orgId", orgId).eq("objectId", object._id)).collect() });
  }
  const key = batchKey(records);
  const done = await ctx.db.query("imports").withIndex("by_org_key", (q) => q.eq("orgId", orgId).eq("key", key)).unique();
  const counts: Record<string, number> = {};
  for (const record of records) counts[record.object] = (counts[record.object] ?? 0) + 1;
  return { records, principal, items, key, done, counts };
}

// The real import and its dry run share this path. "@tmpId" in a lookup or list
// is checked against the live field's target, then becomes the id written
// earlier in this batch; a dry run has no ids, so a stand-in fills its place.
async function valuesFor(ctx: Ctx, principal: Membership, item: Item, record: ImportRecord, earlier: Map<string, { objectId: Id<"objects">; id?: Id<"records"> }>) {
  const pending: Pending = (field, tmpId, fieldKey) => {
    const target = earlier.get(tmpId);
    if (!target) fail("VALIDATION", `"@${tmpId}" is not an earlier record in this file`, { fieldKey });
    if (field.targetObjectId && field.targetObjectId !== target.objectId) fail("VALIDATION", `@${tmpId} is not a record this field can link to`, { fieldKey });
    return target.id ? { id: target.id } : { standIn: `@${tmpId}` };
  };
  const values = await resolveValues(ctx, principal, item.object, item.fields, record.values, pending);
  for (const field of item.fields) if (field.required && !field.retired && values[field._id] == null) fail("VALIDATION", "Required field is empty", { fieldKey: field.key });
  return values;
}

// Names the record and field in every error, since the drafter only knows tmpIds and keys.
async function tagged<T>(record: ImportRecord, item: Item, run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (error) {
    if (!(error instanceof ConvexError)) throw error;
    const data = error.data as { message?: string; fieldKey?: string; fieldId?: string };
    const key = data.fieldKey ?? item.fields.find((field) => field._id === data.fieldId)?.key;
    fail("VALIDATION", `${record.tmpId} (${record.object})${key ? `.${key}` : ""}: ${data.message}`, { tmpId: record.tmpId });
  }
}

export const batch = internalMutation({ args, handler: async (ctx, { orgId, batch }) => {
  const plan = await prepare(ctx, orgId, batch);
  if (plan.done) return { status: "already imported", batchKey: plan.key, counts: plan.done.counts };
  const actor = { kind: "automation" as const, id: `import ${new Date().toISOString().slice(0, 10)}` };
  const earlier = new Map<string, { objectId: Id<"objects">; id: Id<"records"> }>();
  for (const record of plan.records) {
    const item = plan.items.get(record.object)!;
    const recordId = await tagged(record, item, async () => (await applyChange(ctx, plan.principal, { action: "create", orgId, objectId: item.object._id, values: await valuesFor(ctx, plan.principal, item, record, earlier), reason: `Imported from batch ${plan.key}` }, { actor })).recordId);
    earlier.set(record.tmpId, { objectId: item.object._id, id: recordId });
  }
  await ctx.db.insert("imports", { orgId, key: plan.key, counts: plan.counts });
  return { status: "imported", batchKey: plan.key, counts: plan.counts, ids: Object.fromEntries([...earlier].map(([tmpId, { id }]) => [tmpId, id])) };
} });

export const check = internalQuery({ args, handler: async (ctx, { orgId, batch }) => {
  const plan = await prepare(ctx, orgId, batch);
  const earlier = new Map<string, { objectId: Id<"objects"> }>();
  if (!plan.done) for (const record of plan.records) { const item = plan.items.get(record.object)!; await tagged(record, item, () => valuesFor(ctx, plan.principal, item, record, earlier)); earlier.set(record.tmpId, { objectId: item.object._id }); }
  return { status: plan.done ? "already imported" : "ready", batchKey: plan.key, counts: plan.counts };
} });
