import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { Actor, Principal } from "../identity";
import { fail } from "../errors";
import { canReadField, requireObjectAdministration, requireObjectRead } from "../authority/reads";
import { checkNewField, checkObject, checkOptions, createField, createObject, fieldFor, requireLabel, requireUnrestricted, type FieldSpec, type Lifecycle, type Option, type ShapeChange } from "./metadata";
import { applyLifecycle, checkLifecycle } from "./lifecycle";
import { checkView, type ViewSpec } from "./views";
import { insertView } from "../views";

// Turns a shape change named by keys (an agent's proposal, or one step of a blueprint) into
// one named by ids, checked against exactly what applying it will check, so a change a
// person cannot apply is refused now.
type Ctx = QueryCtx | MutationCtx;
type FieldInput = { key: string; label: string; type: string; options?: Option[]; target?: string; withTime?: boolean; required?: boolean; indexed?: boolean };
type ViewInput = { name?: string; layout?: string; columns?: string[]; filters?: { field: string; value: unknown }[]; range?: { field: string; from?: string; to?: string; relative?: string }; sort?: { field: string; direction: "asc" | "desc" }; groupBy?: string; dateField?: string; pinned?: boolean };
export type ChangeInput = ViewInput & { kind: string; object?: string; field?: string; key?: string; label?: string; labelPlural?: string; icon?: string; type?: string; options?: Option[]; target?: string; withTime?: boolean; required?: boolean; indexed?: boolean; fields?: FieldInput[]; order?: string[] };
export const kinds = ["addObject", "addField", "addOptions", "relabel", "addView", "retireField", "restoreField", "reorderFields", "reorderObjects", "reorderOptions", "archiveObject", "unarchiveObject", "setTitleField"];
const types = ["text", "number", "select", "date", "boolean", "lookup", "links"] as const;
async function readableObject(ctx: Ctx, principal: Principal, key: string | undefined) {
  if (!key) fail("VALIDATION", "object is required");
  const object = await ctx.db.query("objects").withIndex("by_org_key", (q) => q.eq("orgId", principal.org._id).eq("key", key)).unique();
  if (!object) fail("NOT_FOUND", "Object not found");
  requireObjectRead(principal, object);
  return object;
}
async function readableField(ctx: Ctx, principal: Principal, object: Doc<"objects">, key: string | undefined, retired = false) {
  if (!key) fail("VALIDATION", "field is required");
  const field = await ctx.db.query("fields").withIndex("by_object_key", (q) => q.eq("orgId", principal.org._id).eq("objectId", object._id).eq("key", key)).unique();
  if (!field || (field.retired && !retired) || !canReadField(principal, object, field)) fail("NOT_FOUND", "Field not found");
  return field;
}
async function specOf(ctx: Ctx, principal: Principal, input: Partial<FieldInput>): Promise<FieldSpec> {
  if (!input.key || !input.label || !input.type) fail("VALIDATION", "key, label and type are required");
  const type = types.find((t) => t === input.type); if (!type) fail("VALIDATION", `Unknown field type; use one of ${types.join(", ")}`);
  // Unknown and unreadable targets answer alike, so a proposal cannot probe for objects.
  const target = input.target === undefined ? undefined : await readableObject(ctx, principal, input.target);
  return { key: input.key, label: input.label, type, ...(input.options ? { options: input.options } : {}), ...(target ? { targetObjectId: target._id } : {}), ...(input.withTime === undefined ? {} : { withTime: input.withTime }), ...(input.required === undefined ? {} : { required: input.required }), ...(input.indexed === undefined ? {} : { indexed: input.indexed }) };
}
// Names in an order list become ids; one that names nothing breaks the list like a missing one would.
const ids = <T extends string>(keys: string[] | undefined, docs: { key: string; _id: T }[]) => (keys ?? []).map((key) => docs.find((doc) => doc.key === key)?._id ?? (key as T));
// The lifecycle kinds are validated by the very check a person's mutation runs (lib/lifecycle.ts).
async function lifecycleFor(ctx: Ctx, principal: Principal, input: ChangeInput): Promise<Lifecycle | null> {
  const orgId = principal.org._id;
  const change: Lifecycle | null = await (async () => {
    switch (input.kind) {
      case "reorderObjects": return { kind: "reorderObjects", objectIds: ids(input.order, await ctx.db.query("objects").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()) };
      case "archiveObject": case "unarchiveObject": return { kind: input.kind, objectId: (await readableObject(ctx, principal, input.object))._id };
      case "reorderFields": { const object = await readableObject(ctx, principal, input.object), fields = await ctx.db.query("fields").withIndex("by_object", (q) => q.eq("orgId", orgId).eq("objectId", object._id)).collect(); return { kind: "reorderFields", objectId: object._id, fieldIds: ids(input.order, fields.filter((f) => !f.retired && canReadField(principal, object, f))) }; }
      case "retireField": case "restoreField": case "setTitleField": case "reorderOptions": {
        const object = await readableObject(ctx, principal, input.object), field = await readableField(ctx, principal, object, input.field, true);
        return input.kind === "reorderOptions" ? { kind: input.kind, objectId: object._id, fieldId: field._id, optionIds: input.order ?? [] } : { kind: input.kind, objectId: object._id, fieldId: field._id };
      }
    }
    return null;
  })();
  if (change) await checkLifecycle(ctx, principal, change);
  return change;
}
export async function changeFor(ctx: Ctx, principal: Principal, input: ChangeInput): Promise<ShapeChange> {
  const lifecycle = await lifecycleFor(ctx, principal, input);
  if (lifecycle) return lifecycle;
  switch (input.kind) {
    case "addObject": {
      if (!input.key || !input.label || !input.labelPlural) fail("VALIDATION", "key, label and labelPlural are required");
      if ((input.fields?.length ?? 0) > 12) fail("VALIDATION", "A new object can start with at most 12 fields");
      await requireUnrestricted(ctx, principal);
      const spec = { key: input.key, label: input.label, labelPlural: input.labelPlural, ...(input.icon === undefined ? {} : { icon: input.icon }) }, fields = [];
      for (const field of input.fields ?? []) fields.push(await specOf(ctx, principal, field));
      await checkObject(ctx, principal, spec, fields);
      return { kind: "addObject", ...spec, fields };
    }
    case "addField": {
      const object = await readableObject(ctx, principal, input.object), field = await specOf(ctx, principal, input);
      await checkNewField(ctx, principal, object, field);
      return { kind: "addField", objectId: object._id, field };
    }
    case "addOptions": {
      const object = await readableObject(ctx, principal, input.object), { field } = await fieldFor(ctx, principal, (await readableField(ctx, principal, object, input.field))._id);
      const options = input.options ?? [], existing = field.options ?? [];
      checkOptions(field, options);
      if (existing.some((old) => { const next = options.find((o) => o.id === old.id); return JSON.stringify(next) !== JSON.stringify(old); })) fail("VALIDATION", "Agents can add options but not change existing ones");
      const added = options.filter((o) => !existing.some((old) => old.id === o.id));
      if (!added.length) fail("VALIDATION", "No new options");
      return { kind: "addOptions", objectId: object._id, fieldId: field._id, options: added };
    }
    case "addView": {
      // Fields by key, then the same check as a person saving it, which coerces filter values.
      const object = await readableObject(ctx, principal, input.object), field = async (key: string) => (await readableField(ctx, principal, object, key))._id;
      const layout = (["table", "board", "calendar"] as const).find((l) => l === (input.layout ?? "table")); if (!layout) fail("VALIDATION", "Unknown layout; use table, board or calendar");
      const relative = input.range?.relative === undefined ? undefined : (["today", "next7", "thisMonth", "overdue"] as const).find((r) => r === input.range!.relative);
      if (input.range?.relative !== undefined && !relative) fail("VALIDATION", "Unknown relative range; use today, next7, thisMonth or overdue");
      const filters = [];
      for (const f of input.filters ?? []) filters.push({ fieldId: await field(f.field), value: f.value });
      const view: ViewSpec = { name: input.name ?? "", layout, columns: await Promise.all((input.columns ?? []).map(field)), filters,
        ...(input.range ? { range: { fieldId: await field(input.range.field), ...(input.range.from === undefined ? {} : { from: input.range.from }), ...(input.range.to === undefined ? {} : { to: input.range.to }), ...(relative ? { relative } : {}) } } : {}),
        ...(input.sort ? { sort: { fieldId: await field(input.sort.field), direction: input.sort.direction } } : {}),
        ...(input.groupBy ? { groupFieldId: await field(input.groupBy) } : {}), ...(input.dateField ? { dateFieldId: await field(input.dateField) } : {}) };
      return { kind: "addView", objectId: object._id, view: await checkView(ctx, principal, object, view), ...(input.pinned ? { pinned: true } : {}) };
    }
    case "relabel": {
      const object = await readableObject(ctx, principal, input.object);
      requireLabel(input.label);
      if (input.field !== undefined) {
        if (input.labelPlural !== undefined) fail("VALIDATION", "Only objects have a plural label");
        const { field } = await fieldFor(ctx, principal, (await readableField(ctx, principal, object, input.field))._id);
        return { kind: "relabel", objectId: object._id, fieldId: field._id, label: input.label! };
      }
      await requireObjectAdministration(ctx, principal, object);
      if (input.labelPlural !== undefined) requireLabel(input.labelPlural, "Plural label");
      return { kind: "relabel", objectId: object._id, label: input.label!, ...(input.labelPlural === undefined ? {} : { labelPlural: input.labelPlural }) };
    }
  }
  fail("VALIDATION", `Unknown kind; use one of ${kinds.join(", ")}`);
}

// Each helper checks everything before its first write, so a refusal caught here
// leaves nothing behind and the proposal is marked failed instead. A view is shared and
// saved by the person applying it (only an admin may share one), credited to createdBy.
export async function perform(ctx: MutationCtx, principal: Principal, change: Exclude<ShapeChange, { kind: "blueprint" }>, createdBy?: Actor): Promise<{ objectId?: Id<"objects">; fieldIds: Id<"fields">[]; viewId?: Id<"views"> }> {
  if (change.kind === "addObject") { const { kind, fields, ...spec } = change; return createObject(ctx, principal, spec, fields); }
  if (change.kind === "reorderObjects") return { fieldIds: (await applyLifecycle(ctx, principal, change)).fieldIds };
  if (change.kind !== "addField" && change.kind !== "addOptions" && change.kind !== "relabel" && change.kind !== "addView") return { objectId: change.objectId, fieldIds: (await applyLifecycle(ctx, principal, change)).fieldIds };
  const object = await ctx.db.get(change.objectId);
  if (!object) fail("NOT_FOUND", "Object not found");
  if (change.kind === "addView") {
    if (!("member" in principal)) fail("FORBIDDEN", "Only a person can save a shared view");
    return { objectId: object._id, fieldIds: [], viewId: await insertView(ctx, principal, object, change.view, { shared: true, pinned: change.pinned, createdBy: (createdBy ?? principal.actor) as Doc<"views">["createdBy"] }) };
  }
  if (change.kind === "addField") return { objectId: object._id, fieldIds: [(await createField(ctx, principal, object, change.field)).fieldId] };
  if (change.kind === "addOptions") {
    const { field } = await fieldFor(ctx, principal, change.fieldId);
    if (field.retired) fail("VALIDATION", "Field was retired");
    if (change.options.some((o) => field.options?.some((old) => old.id === o.id))) fail("VALIDATION", "Option already exists");
    const options = [...(field.options ?? []), ...change.options];
    checkOptions(field, options);
    await ctx.db.patch(field._id, { options });
    return { objectId: object._id, fieldIds: [field._id] };
  }
  requireLabel(change.label);
  if (change.fieldId) {
    const { field } = await fieldFor(ctx, principal, change.fieldId);
    if (field.retired) fail("VALIDATION", "Field was retired");
    await ctx.db.patch(field._id, { label: change.label });
    return { objectId: object._id, fieldIds: [field._id] };
  }
  await requireObjectAdministration(ctx, principal, object);
  await ctx.db.patch(object._id, { label: change.label, ...(change.labelPlural === undefined ? {} : { labelPlural: change.labelPlural }) });
  return { objectId: object._id, fieldIds: [] };
}
