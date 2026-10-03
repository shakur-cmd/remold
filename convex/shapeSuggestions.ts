import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { ConvexError, v } from "convex/values";
import { requireMember, requireWriter, type AgentMembership, type Membership, type Principal } from "./identity";
import { fail } from "./errors";
import { canReadField, canReadObject, requireObjectAdministration, requireObjectRead } from "./authority/reads";
import { checkNewField, checkObject, checkOptions, createField, createObject, fieldFor, requireLabel, requireUnrestricted, type FieldSpec, type Lifecycle, type Option, type ShapeChange } from "./lib/metadata";
import { applyLifecycle, checkLifecycle } from "./lib/lifecycle";

type Ctx = QueryCtx | MutationCtx;
type Row = Doc<"shapeSuggestions">;
const status = v.union(v.literal("pending"), v.literal("applied"), v.literal("dismissed"), v.literal("failed"));

// A person sees, applies or dismisses a proposal only if Settings would let them
// make the same change. Anything about an object they cannot read stays hidden.
async function authorize(ctx: Ctx, principal: Membership, row: Row) {
  if (row.orgId !== principal.org._id) fail("NOT_FOUND", "Proposal not found");
  const change = row.change;
  if (change.kind === "addObject" || change.kind === "reorderObjects") return requireUnrestricted(ctx, principal);
  const object = await ctx.db.get(change.objectId), target = change.kind === "addField" && change.field.targetObjectId ? await ctx.db.get(change.field.targetObjectId) : null;
  if (!object || !canReadObject(principal, object) || (target && !canReadObject(principal, target))) fail("NOT_FOUND", "Proposal not found");
  await requireObjectAdministration(ctx, principal, object);
}
const visible = (ctx: Ctx, principal: Membership, row: Row) => authorize(ctx, principal, row).then(() => true, () => false);
const active = (agent: Doc<"agents"> | null, row: Row) => !!agent && agent.revokedAt === undefined && (agent.state === undefined || agent.state === "active") && (agent.authorityEpoch ?? 0) === row.authorityEpoch;

// Plain words for the Suggestions page and for agents: "Add field Budget (number) to Opportunity".
const typeLabel = (field: FieldSpec, targets: Map<string, string>) => field.targetObjectId ? `${field.type} to ${targets.get(field.targetObjectId) ?? "an object"}` : field.type;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
function fieldDetail(field: FieldSpec, targets: Map<string, string>) {
  return `${field.label} (${typeLabel(field, targets)})${field.options ? `: ${field.options.map((o) => o.label).join(", ")}` : ""}${field.required ? ", required" : ""}${field.withTime ? ", with time" : ""}${field.indexed === false ? ", not searchable or sortable" : ""}`;
}
export async function describe(ctx: Ctx, change: ShapeChange) {
  const label = async (id: Id<"objects"> | Id<"fields"> | undefined) => (id ? (await ctx.db.get(id))?.label : undefined) ?? "a removed item";
  const specs = change.kind === "addObject" ? change.fields : change.kind === "addField" ? [change.field] : [];
  const targets = new Map(await Promise.all(specs.flatMap((f) => f.targetObjectId ? [f.targetObjectId] : []).map(async (id) => [id as string, await label(id)] as const)));
  switch (change.kind) {
    case "addObject": return { summary: `Add object ${change.label}${change.fields.length ? ` with ${plural(change.fields.length, "field")}` : ""}`, details: change.fields.map((f) => fieldDetail(f, targets)) };
    case "addField": return { summary: `Add field ${change.field.label} (${typeLabel(change.field, targets)}) to ${await label(change.objectId)}`, details: change.field.options || change.field.required || change.field.withTime || change.field.indexed === false ? [fieldDetail(change.field, targets)] : [] };
    case "addOptions": return { summary: `Add ${change.options.length === 1 ? "option" : "options"} ${change.options.map((o) => o.label).join(", ")} to ${await label(change.fieldId)} on ${await label(change.objectId)}`, details: [] };
    case "relabel": return change.fieldId
      ? { summary: `Rename field ${await label(change.fieldId)} to ${change.label} on ${await label(change.objectId)}`, details: [] }
      : { summary: `Rename object ${await label(change.objectId)} to ${change.label}${change.labelPlural ? ` (plural ${change.labelPlural})` : ""}`, details: [] };
    case "retireField": return { summary: `Retire field ${await label(change.fieldId)} on ${await label(change.objectId)}`, details: [] };
    case "restoreField": return { summary: `Restore field ${await label(change.fieldId)} on ${await label(change.objectId)}`, details: [] };
    case "reorderFields": return { summary: `Reorder the fields of ${await label(change.objectId)}`, details: [`New order: ${(await Promise.all(change.fieldIds.map(label))).join(", ")}`] };
    case "reorderObjects": return { summary: "Reorder the objects in the navigation", details: [`New order: ${(await Promise.all(change.objectIds.map(async (id) => (await ctx.db.get(id))?.labelPlural ?? "a removed item"))).join(", ")}`] };
    case "reorderOptions": { const field = await ctx.db.get(change.fieldId); return { summary: `Reorder the options of ${field?.label ?? "a removed item"} on ${await label(change.objectId)}`, details: [`New order: ${change.optionIds.map((id) => field?.options?.find((o) => o.id === id)?.label ?? id).join(", ")}`] }; }
    case "archiveObject": return { summary: `Archive object ${await label(change.objectId)}`, details: [] };
    case "unarchiveObject": return { summary: `Unarchive object ${await label(change.objectId)}`, details: [] };
    case "setTitleField": return { summary: `Use ${await label(change.fieldId)} as the title of ${await label(change.objectId)}`, details: [] };
  }
}

// Agent side: validates a proposal against exactly what applying it will check, so a
// proposal a person cannot apply is refused now. Input names objects and fields by key.
type FieldInput = { key: string; label: string; type: string; options?: Option[]; target?: string; withTime?: boolean; required?: boolean; indexed?: boolean };
export type ProposalInput = { kind: string; reason: string; object?: string; field?: string; key?: string; label?: string; labelPlural?: string; icon?: string; type?: string; options?: Option[]; target?: string; withTime?: boolean; required?: boolean; indexed?: boolean; fields?: FieldInput[]; order?: string[] };
const kinds = ["addObject", "addField", "addOptions", "relabel", "retireField", "restoreField", "reorderFields", "reorderObjects", "reorderOptions", "archiveObject", "unarchiveObject", "setTitleField"];
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
// Names in an agent's order list become ids; one that names nothing breaks the list like a missing one would.
const ids = <T extends string>(keys: string[] | undefined, docs: { key: string; _id: T }[]) => (keys ?? []).map((key) => docs.find((doc) => doc.key === key)?._id ?? (key as T));
// The lifecycle kinds are validated by the very check a person's mutation runs (lib/lifecycle.ts).
async function lifecycleFor(ctx: Ctx, principal: AgentMembership, input: ProposalInput): Promise<Lifecycle | null> {
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
export async function proposalFor(ctx: Ctx, principal: AgentMembership, input: ProposalInput): Promise<ShapeChange> {
  if (principal.agent.role !== "admin") fail("FORBIDDEN", "Only an admin agent can propose shape changes");
  if (!input.reason.trim()) fail("VALIDATION", "reason is required");
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
// leaves nothing behind and the proposal is marked failed instead.
async function perform(ctx: MutationCtx, principal: Membership, change: ShapeChange): Promise<{ objectId?: Id<"objects">; fieldIds: Id<"fields">[] }> {
  if (change.kind === "addObject") { const { kind, fields, ...spec } = change; return createObject(ctx, principal, spec, fields); }
  if (change.kind === "reorderObjects") return { fieldIds: (await applyLifecycle(ctx, principal, change)).fieldIds };
  if (change.kind !== "addField" && change.kind !== "addOptions" && change.kind !== "relabel") return { objectId: change.objectId, fieldIds: (await applyLifecycle(ctx, principal, change)).fieldIds };
  const object = await ctx.db.get(change.objectId);
  if (!object) fail("NOT_FOUND", "Object not found");
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
const stale = (error: unknown) => error instanceof ConvexError && ["VALIDATION", "NOT_FOUND", "SLOTS_EXHAUSTED"].includes((error.data as { code?: string })?.code ?? "");

// What objects.impact needs to describe a retire or archive before it is applied. Each card
// loads its own preview, so the list stays one bounded read however many proposals wait.
const previewOf = (change: ShapeChange) => change.kind === "retireField" ? { objectId: change.objectId, fieldId: change.fieldId } : change.kind === "archiveObject" ? { objectId: change.objectId } : null;
async function personRow(ctx: Ctx, row: Row) {
  const agent = await ctx.db.get(row.agentId);
  return { _id: row._id, _creationTime: row._creationTime, kind: row.change.kind, status: row.status, ...await describe(ctx, row.change), preview: row.status === "pending" ? previewOf(row.change) : null, reason: row.reason, agentName: agent?.name ?? null, paused: row.status === "pending" && !active(agent, row), error: row.error ?? null, resolvedAt: row.resolvedAt ?? null };
}
export const list = query({ args: { orgId: v.id("orgs"), status: v.optional(status) }, handler: async (ctx, args) => {
  const principal = await requireMember(ctx, args.orgId);
  if (principal.member.role === "member") return [];
  const rows = await ctx.db.query("shapeSuggestions").withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", args.status ?? "pending")).order("desc").take(200);
  const shown = [];
  for (const row of rows) if (await visible(ctx, principal, row)) shown.push(await personRow(ctx, row));
  return shown;
} });

export const apply = mutation({ args: { orgId: v.id("orgs"), id: v.id("shapeSuggestions") }, handler: async (ctx, args) => {
  const principal = await requireWriter(ctx, args.orgId, "admin"), row = await ctx.db.get(args.id);
  if (!row) fail("NOT_FOUND", "Proposal not found");
  await authorize(ctx, principal, row);
  if (row.status !== "pending") return { status: "already" as const, current: row.status };
  const agent = await ctx.db.get(row.agentId);
  if (!active(agent, row)) fail("FORBIDDEN", "This agent's access changed after it proposed this. Dismiss it, or make the change yourself in Settings.");
  let result;
  try { result = await perform(ctx, principal, row.change); }
  catch (error) {
    if (!stale(error)) throw error;
    const message = String(((error as ConvexError<{ message?: string }>).data)?.message ?? "No longer applies");
    await ctx.db.patch(row._id, { status: "failed", error: message, resolvedBy: principal.user._id, resolvedAt: Date.now() });
    return { status: "failed" as const, error: message };
  }
  const { objectId, fieldIds } = result;
  await ctx.db.patch(row._id, { status: "applied", ...(objectId ? { result: { objectId, fieldIds } } : {}), resolvedBy: principal.user._id, resolvedAt: Date.now() });
  // The agent asked for this object to work in it; without read access it could never use it.
  if (row.change.kind === "addObject" && objectId && agent!.authorityVersion === 1) {
    await ctx.db.patch(agent!._id, { readObjectIds: [...(agent!.readObjectIds ?? []), objectId] });
    await ctx.db.insert("authorityAudit", { orgId: args.orgId, actor: principal.actor, action: "agentReadExtended", targetId: agent!._id, objectIds: [objectId] });
  }
  await ctx.db.insert("authorityAudit", { orgId: args.orgId, actor: principal.actor, action: "shapeProposalApplied", targetId: row._id, objectIds: objectId ? [objectId] : row.change.kind === "reorderObjects" ? row.change.objectIds : [] });
  return { status: "applied" as const, ...result };
} });

// Like suggestions.dismiss, a reduction: it stays available while the workspace is read only.
export const dismiss = mutation({ args: { orgId: v.id("orgs"), id: v.id("shapeSuggestions") }, handler: async (ctx, args) => {
  const principal = await requireMember(ctx, args.orgId, "admin"), row = await ctx.db.get(args.id);
  if (!row) fail("NOT_FOUND", "Proposal not found");
  await authorize(ctx, principal, row);
  if (row.status !== "pending") return { status: "already" as const };
  await ctx.db.patch(row._id, { status: "dismissed", resolvedBy: principal.user._id, resolvedAt: Date.now() });
  return { status: "dismissed" as const };
} });

// What an agent sees of its own proposals: keys rather than ids, so it can use the result.
export async function agentRow(ctx: Ctx, row: Row) {
  const object = row.result ? await ctx.db.get(row.result.objectId) : null, fields = row.result ? await Promise.all(row.result.fieldIds.map((id) => ctx.db.get(id))) : [];
  return { id: row._id, kind: row.change.kind, status: row.status, ...await describe(ctx, row.change), reason: row.reason, createdAt: row._creationTime, resolvedAt: row.resolvedAt ?? null, error: row.error ?? null, result: object ? { object: object.key, fields: fields.flatMap((f) => f ? [f.key] : []) } : null };
}
