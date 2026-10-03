import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { v, type Infer } from "convex/values";
import type { Principal } from "../identity";
import { fail } from "../errors";
import { canReadField, canReadObject, requireObjectAdministration, requireObjectRead } from "../authority/reads";
import { unrestrictedHuman } from "../authority/inbox";
import { allocateSlot, capacity, kindFor, type SlotKind } from "./slots";

// The rules for changing a workspace's shape, shared by a person's own Settings
// mutations and by applying an agent's proposal, so the two cannot drift apart.
type Ctx = QueryCtx | MutationCtx;
export const fieldType = v.union(v.literal("text"), v.literal("number"), v.literal("select"), v.literal("date"), v.literal("boolean"), v.literal("lookup"), v.literal("links"));
export const option = v.object({ id: v.string(), label: v.string(), color: v.optional(v.string()) });
export const fieldSpec = v.object({ key: v.string(), label: v.string(), type: fieldType, options: v.optional(v.array(option)), targetObjectId: v.optional(v.id("objects")), required: v.optional(v.boolean()), withTime: v.optional(v.boolean()), indexed: v.optional(v.boolean()) });
export const objectSpec = { key: v.string(), label: v.string(), labelPlural: v.string(), icon: v.optional(v.string()) };
// What agents send: objects and fields named by key. A blueprint is a list of these (lib/blueprint.ts).
export const fieldInput = { key: v.string(), label: v.string(), type: v.string(), options: v.optional(v.array(option)), target: v.optional(v.string()), withTime: v.optional(v.boolean()), required: v.optional(v.boolean()), indexed: v.optional(v.boolean()) };
export const changeInput = { kind: v.string(), object: v.optional(v.string()), field: v.optional(v.string()), key: v.optional(v.string()), label: v.optional(v.string()), labelPlural: v.optional(v.string()), icon: v.optional(v.string()), type: v.optional(v.string()), options: v.optional(v.array(option)), target: v.optional(v.string()), withTime: v.optional(v.boolean()), required: v.optional(v.boolean()), indexed: v.optional(v.boolean()), fields: v.optional(v.array(v.object(fieldInput))), order: v.optional(v.array(v.string())) };
export const blueprint = v.object({ version: v.number(), name: v.string(), description: v.optional(v.string()), changes: v.array(v.object(changeInput)), records: v.optional(v.array(v.object({ object: v.string(), values: v.record(v.string(), v.any()) }))) });
export const shapeChange = v.union(
  v.object({ kind: v.literal("addObject"), ...objectSpec, fields: v.array(fieldSpec) }),
  v.object({ kind: v.literal("addField"), objectId: v.id("objects"), field: fieldSpec }),
  // Only the options to add; existing ones are kept as they are when it is applied.
  v.object({ kind: v.literal("addOptions"), objectId: v.id("objects"), fieldId: v.id("fields"), options: v.array(option) }),
  v.object({ kind: v.literal("relabel"), objectId: v.id("objects"), fieldId: v.optional(v.id("fields")), label: v.string(), labelPlural: v.optional(v.string()) }),
  // Lifecycle: nothing is deleted; each has an inverse (convex/lib/lifecycle.ts).
  v.object({ kind: v.literal("retireField"), objectId: v.id("objects"), fieldId: v.id("fields") }),
  v.object({ kind: v.literal("restoreField"), objectId: v.id("objects"), fieldId: v.id("fields") }),
  v.object({ kind: v.literal("reorderFields"), objectId: v.id("objects"), fieldIds: v.array(v.id("fields")) }),
  v.object({ kind: v.literal("reorderObjects"), objectIds: v.array(v.id("objects")) }),
  v.object({ kind: v.literal("reorderOptions"), objectId: v.id("objects"), fieldId: v.id("fields"), optionIds: v.array(v.string()) }),
  v.object({ kind: v.literal("archiveObject"), objectId: v.id("objects") }),
  v.object({ kind: v.literal("unarchiveObject"), objectId: v.id("objects") }),
  v.object({ kind: v.literal("setTitleField"), objectId: v.id("objects"), fieldId: v.id("fields") }),
  // Applied all at once by lib/blueprint.ts; objects are named by key, since new ones have no id yet.
  v.object({ kind: v.literal("blueprint"), blueprint }),
);
export type ShapeChange = Infer<typeof shapeChange>;
export type Lifecycle = Exclude<ShapeChange, { kind: "addObject" | "addField" | "addOptions" | "relabel" | "blueprint" }>;
export type Blueprint = Infer<typeof blueprint>;
export type FieldSpec = Infer<typeof fieldSpec>;
export type Option = Infer<typeof option>;
type ObjectSpec = { key: string; label: string; labelPlural: string; icon?: string };

export const validKey = (key: string) => /^[a-z][a-zA-Z0-9]*$/.test(key);
const uniqueOptions = (value: { id: string }[] | undefined) => !!value?.length && new Set(value.map((o) => o.id)).size === value.length;
export const fieldsOf = (ctx: Ctx, orgId: Id<"orgs">, objectId: Id<"objects">) => ctx.db.query("fields").withIndex("by_object", (q) => q.eq("orgId", orgId).eq("objectId", objectId)).collect();

// A new object can collide with any object key, so only someone who sees every object may add one.
export async function unrestricted(ctx: Ctx, principal: Principal) {
  if ("member" in principal) return unrestrictedHuman(principal);
  if (principal.agent.hiddenFieldIds?.length) return false;
  const objects = await ctx.db.query("objects").withIndex("by_org", (q) => q.eq("orgId", principal.org._id)).collect();
  for (const object of objects) { if (!canReadObject(principal, object)) return false; for (const field of await fieldsOf(ctx, principal.org._id, object._id)) if (!canReadField(principal, object, field)) return false; }
  return true;
}
export async function requireUnrestricted(ctx: Ctx, principal: Principal) { if (!await unrestricted(ctx, principal)) fail("FORBIDDEN", "Unrestricted workspace access required"); }
export const requireLabel = (label: string | undefined, what = "Label") => { if (!label?.trim()) fail("VALIDATION", `${what} is required`); };

export async function checkObject(ctx: Ctx, principal: Principal, spec: ObjectSpec, fields: FieldSpec[] = []) {
  if (!validKey(spec.key)) fail("VALIDATION", "Invalid object key");
  requireLabel(spec.label); requireLabel(spec.labelPlural, "Plural label");
  if (await ctx.db.query("objects").withIndex("by_org_key", (q) => q.eq("orgId", principal.org._id).eq("key", spec.key)).unique()) fail("VALIDATION", "Object key already exists");
  // Every new object starts with a Name title field in a text slot.
  const taken = new Set(["name"]), used: Record<SlotKind, number> = { n: 0, s: 1, d: 0, b: 0 };
  for (const field of fields) { await checkField(ctx, principal, field, taken, used); taken.add(field.key); }
}
// taken and used describe the object as it is (or will be, for fields proposed together).
async function checkField(ctx: Ctx, principal: Principal, spec: FieldSpec, taken: Set<string>, used: Record<SlotKind, number>) {
  if (!validKey(spec.key)) fail("VALIDATION", "Invalid field key");
  requireLabel(spec.label);
  if (taken.has(spec.key)) fail("VALIDATION", "Field key already exists");
  if (spec.type === "select" && !uniqueOptions(spec.options)) fail("VALIDATION", "Select needs unique options");
  if (spec.type !== "select" && spec.options) fail("VALIDATION", "Only select fields have options");
  if (spec.withTime !== undefined && spec.type !== "date") fail("VALIDATION", "Only date fields keep time");
  if (spec.indexed === false && spec.type !== "text") fail("VALIDATION", "Only text fields can skip the index");
  if (spec.targetObjectId && spec.type !== "lookup" && spec.type !== "links") fail("VALIDATION", "Only relation fields have a target");
  if (spec.targetObjectId) { const target = await ctx.db.get(spec.targetObjectId); if (!target || target.orgId !== principal.org._id) fail("NOT_FOUND", "Target object not found"); requireObjectRead(principal, target); }
  // Related records are found through the lookup's slot, so a lookup without one would not work.
  const kind = spec.indexed === false ? undefined : kindFor(spec.type);
  if (kind) { if (spec.type === "lookup" && used[kind] >= capacity[kind]) fail("SLOTS_EXHAUSTED", "No index slot left for another lookup on this object"); used[kind] += 1; }
}
export async function checkNewField(ctx: Ctx, principal: Principal, object: Doc<"objects">, spec: FieldSpec) {
  await requireObjectAdministration(ctx, principal, object);
  const existing = await fieldsOf(ctx, principal.org._id, object._id), used: Record<SlotKind, number> = { n: 0, s: 0, d: 0, b: 0 };
  for (const field of existing) if (field.slot) used[field.slot.kind] += 1;
  await checkField(ctx, principal, spec, new Set(existing.map((f) => f.key)), used);
}
// A select may gain options and relabel them, never lose one: records keep the ids they hold.
export function checkOptions(field: Doc<"fields">, options: Option[]) {
  if (field.type !== "select" || !uniqueOptions(options)) fail("VALIDATION", "Invalid options");
  if ((field.options ?? []).some((old) => !options.some((o) => o.id === old.id))) fail("VALIDATION", "Options cannot be removed");
}
export async function fieldFor(ctx: Ctx, principal: Principal, fieldId: Id<"fields">) {
  const field = await ctx.db.get(fieldId);
  if (!field || field.orgId !== principal.org._id) fail("NOT_FOUND", "Field not found");
  const object = await ctx.db.get(field.objectId); if (!object) fail("NOT_FOUND");
  await requireObjectAdministration(ctx, principal, object);
  return { field, object };
}

export async function createObject(ctx: MutationCtx, principal: Principal, spec: ObjectSpec, fields: FieldSpec[] = []) {
  await requireUnrestricted(ctx, principal);
  await checkObject(ctx, principal, spec, fields);
  const orgId = principal.org._id, order = (await ctx.db.query("objects").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()).length;
  const objectId = await ctx.db.insert("objects", { orgId, key: spec.key, label: spec.label, labelPlural: spec.labelPlural, ...(spec.icon === undefined ? {} : { icon: spec.icon }), isStandard: false, order });
  const fieldId = await ctx.db.insert("fields", { orgId, objectId, key: "name", label: "Name", type: "text", required: true, slot: await allocateSlot(ctx, orgId, objectId, "s"), encoding: 1, retired: false, order: 0 });
  await ctx.db.patch(objectId, { titleFieldId: fieldId });
  const fieldIds = [];
  for (const field of fields) fieldIds.push((await insertField(ctx, orgId, objectId, field)).fieldId);
  return { objectId, fieldIds };
}
export async function createField(ctx: MutationCtx, principal: Principal, object: Doc<"objects">, spec: FieldSpec) {
  await checkNewField(ctx, principal, object, spec);
  return insertField(ctx, principal.org._id, object._id, spec);
}
async function insertField(ctx: MutationCtx, orgId: Id<"orgs">, objectId: Id<"objects">, { indexed, ...spec }: FieldSpec) {
  const order = (await fieldsOf(ctx, orgId, objectId)).length, kind = indexed === false ? undefined : kindFor(spec.type), slot = kind ? await allocateSlot(ctx, orgId, objectId, kind) : undefined;
  const fieldId = await ctx.db.insert("fields", { orgId, objectId, ...spec, required: spec.required ?? false, slot, encoding: 1, retired: false, order });
  return { fieldId, slot };
}
