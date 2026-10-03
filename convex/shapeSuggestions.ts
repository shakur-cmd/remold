import { action, internalMutation, mutation, query, type QueryCtx, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { ConvexError, v } from "convex/values";
import { api, internal } from "./_generated/api";
import { requireMember, requireWriter, type AgentMembership, type Membership, type Principal } from "./identity";
import { fail } from "./errors";
import { canReadField, canReadObject, requireObjectAdministration } from "./authority/reads";
import { requireUnrestricted, type Blueprint, type FieldSpec, type ShapeChange } from "./lib/metadata";
import { changeFor, perform, type ChangeInput } from "./lib/proposals";
import { diffOf, parseBlueprint, refusal, requireWholeWorkspace, runBlueprint, summaryOf } from "./lib/blueprint";
import { viewDetails } from "./lib/views";

type Ctx = QueryCtx | MutationCtx;
type Row = Doc<"shapeSuggestions">;
const status = v.union(v.literal("pending"), v.literal("applied"), v.literal("dismissed"), v.literal("failed"));

// A person sees, applies or dismisses a proposal only if Settings would let them
// make the same change. Anything about an object they cannot read stays hidden.
// A blueprint can touch any object, so only someone who sees every object may review one.
export async function authorize(ctx: Ctx, principal: Membership, row: Row) {
  if (row.orgId !== principal.org._id) fail("NOT_FOUND", "Proposal not found");
  const change = row.change;
  if (change.kind === "addObject" || change.kind === "reorderObjects" || change.kind === "blueprint") return requireUnrestricted(ctx, principal);
  // A view changes no shape: anyone who may share views and can read every field it names.
  if (change.kind === "addView") {
    const object = await ctx.db.get(change.objectId), view = change.view, ids = [...view.columns, ...view.filters.map((f) => f.fieldId), view.range?.fieldId, view.sort?.fieldId, view.groupFieldId, view.dateFieldId].filter((id) => id !== undefined);
    const fields = await Promise.all(ids.map((id) => ctx.db.get(id)));
    if (!object || !canReadObject(principal, object) || fields.some((field) => field && !canReadField(principal, object, field))) fail("NOT_FOUND", "Proposal not found");
    return;
  }
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
  if (change.kind === "blueprint") return { summary: summaryOf(change.blueprint), details: [] };
  const specs = change.kind === "addObject" ? change.fields : change.kind === "addField" ? [change.field] : [];
  const targets = new Map(await Promise.all(specs.flatMap((f) => f.targetObjectId ? [f.targetObjectId] : []).map(async (id) => [id as string, await label(id)] as const)));
  switch (change.kind) {
    case "addObject": return { summary: `Add object ${change.label}${change.fields.length ? ` with ${plural(change.fields.length, "field")}` : ""}`, details: change.fields.map((f) => fieldDetail(f, targets)) };
    case "addField": return { summary: `Add field ${change.field.label} (${typeLabel(change.field, targets)}) to ${await label(change.objectId)}`, details: change.field.options || change.field.required || change.field.withTime || change.field.indexed === false ? [fieldDetail(change.field, targets)] : [] };
    case "addView": return { summary: `Add view ${change.view.name} to ${(await ctx.db.get(change.objectId))?.labelPlural ?? "a removed object"}`, details: await viewDetails(ctx, change.view, change.pinned) };
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

// Agent side: the proposal is checked by the same code that will apply it (lib/proposals.ts).
// A blueprint is checked by a trial run before it gets here (lib/blueprint.ts, http.ts).
export type ProposalInput = ChangeInput & { reason: string; blueprint?: Blueprint };
export async function proposalFor(ctx: Ctx, principal: AgentMembership, input: ProposalInput): Promise<ShapeChange> {
  if (principal.agent.role !== "admin") fail("FORBIDDEN", "Only an admin agent can propose shape changes");
  if (!input.reason.trim()) fail("VALIDATION", "reason is required");
  if (input.kind !== "blueprint") return changeFor(ctx, principal, input);
  if (!input.blueprint) fail("VALIDATION", "blueprint is required");
  await requireWholeWorkspace(ctx, principal);
  if (!input.blueprint.changes.length && !input.blueprint.records?.length) fail("VALIDATION", "A blueprint needs at least one change");
  return { kind: "blueprint", blueprint: parseBlueprint(input.blueprint) };
}

const stale = (error: unknown) => error instanceof ConvexError && ["VALIDATION", "NOT_FOUND", "SLOTS_EXHAUSTED"].includes((error.data as { code?: string })?.code ?? "");

// What objects.impact needs to describe a retire or archive before it is applied. Each card
// loads its own preview, so the list stays one bounded read however many proposals wait.
const previewOf = (change: ShapeChange) => change.kind === "retireField" ? { objectId: change.objectId, fieldId: change.fieldId } : change.kind === "archiveObject" ? { objectId: change.objectId } : null;
async function personRow(ctx: Ctx, principal: Principal, row: Row) {
  const agent = await ctx.db.get(row.agentId);
  return { _id: row._id, _creationTime: row._creationTime, kind: row.change.kind, status: row.status, ...await describe(ctx, row.change), blueprint: row.change.kind === "blueprint" ? await diffOf(ctx, principal, row.change.blueprint) : null, preview: row.status === "pending" ? previewOf(row.change) : null, reason: row.reason, agentName: agent?.name ?? null, paused: row.status === "pending" && !active(agent, row), error: row.error ?? null, resolvedAt: row.resolvedAt ?? null };
}
export const list = query({ args: { orgId: v.id("orgs"), status: v.optional(status) }, handler: async (ctx, args) => {
  const principal = await requireMember(ctx, args.orgId);
  if (principal.member.role === "member") return [];
  const rows = await ctx.db.query("shapeSuggestions").withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", args.status ?? "pending")).order("desc").take(200);
  const shown = [];
  for (const row of rows) if (await visible(ctx, principal, row)) shown.push(await personRow(ctx, principal, row));
  return shown;
} });

export const apply = mutation({ args: { orgId: v.id("orgs"), id: v.id("shapeSuggestions"), withRecords: v.optional(v.boolean()) }, handler: async (ctx, args) => {
  const principal = await requireWriter(ctx, args.orgId, "admin"), row = await ctx.db.get(args.id);
  if (!row) fail("NOT_FOUND", "Proposal not found");
  await authorize(ctx, principal, row);
  if (row.status !== "pending") return { status: "already" as const, current: row.status };
  const agent = await ctx.db.get(row.agentId);
  if (!active(agent, row)) fail("FORBIDDEN", "This agent's access changed after it proposed this. Dismiss it, or make the change yourself in Settings.");
  let result: { objectId?: Id<"objects">; fieldIds: Id<"fields">[]; viewId?: Id<"views"> }, created: Id<"objects">[] = [];
  // A blueprint is all or nothing: a refusal at any step throws, so Convex discards the steps
  // before it. applyBlueprint then records the failure in a transaction of its own.
  if (row.change.kind === "blueprint") { created = (await runBlueprint(ctx, principal, row.change.blueprint, { person: principal, records: !!args.withRecords, agent: agent! })).objectIds; result = { fieldIds: [] }; }
  else try { result = await perform(ctx, principal, row.change, { kind: "agent", id: row.agentId }); if (row.change.kind === "addObject" && result.objectId) created = [result.objectId]; }
  catch (error) {
    if (!stale(error)) throw error;
    const message = String(((error as ConvexError<{ message?: string }>).data)?.message ?? "No longer applies");
    await ctx.db.patch(row._id, { status: "failed", error: message, resolvedBy: principal.user._id, resolvedAt: Date.now() });
    return { status: "failed" as const, error: message };
  }
  const { objectId, fieldIds, viewId } = result;
  await ctx.db.patch(row._id, { status: "applied", ...(objectId ? { result: { objectId, fieldIds, ...(viewId ? { viewId } : {}) } } : {}), resolvedBy: principal.user._id, resolvedAt: Date.now() });
  // The agent asked for these objects to work in them; without read access it could never use them.
  if (created.length && agent!.authorityVersion === 1) {
    await ctx.db.patch(agent!._id, { readObjectIds: [...new Set([...(agent!.readObjectIds ?? []), ...created])] });
    await ctx.db.insert("authorityAudit", { orgId: args.orgId, actor: principal.actor, action: "agentReadExtended", targetId: agent!._id, objectIds: created });
  }
  await ctx.db.insert("authorityAudit", { orgId: args.orgId, actor: principal.actor, action: "shapeProposalApplied", targetId: row._id, objectIds: objectId ? [objectId] : row.change.kind === "reorderObjects" ? row.change.objectIds : created });
  return { status: "applied" as const, ...result };
} });

// What Suggestions calls for a blueprint, so a refused one is marked failed (with nothing applied) instead of only raising an error.
export const applyBlueprint = action({ args: { orgId: v.id("orgs"), id: v.id("shapeSuggestions"), withRecords: v.boolean() }, handler: async (ctx, args): Promise<{ status: "applied" | "already" | "failed"; error?: string }> => {
  try { return { status: (await ctx.runMutation(api.shapeSuggestions.apply, args)).status }; }
  catch (error) {
    const message = refusal(error);
    if (!message) throw error;
    await ctx.runMutation(internal.shapeSuggestions.markFailed, { orgId: args.orgId, id: args.id, error: message });
    return { status: "failed", error: message };
  }
} });
export const markFailed = internalMutation({ args: { orgId: v.id("orgs"), id: v.id("shapeSuggestions"), error: v.string() }, handler: async (ctx, args) => {
  const principal = await requireMember(ctx, args.orgId, "admin"), row = await ctx.db.get(args.id);
  if (!row) fail("NOT_FOUND", "Proposal not found");
  await authorize(ctx, principal, row);
  if (row.status === "pending") await ctx.db.patch(row._id, { status: "failed", error: args.error, resolvedBy: principal.user._id, resolvedAt: Date.now() });
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
  return { id: row._id, kind: row.change.kind, status: row.status, ...await describe(ctx, row.change), reason: row.reason, createdAt: row._creationTime, resolvedAt: row.resolvedAt ?? null, error: row.error ?? null, result: object ? { object: object.key, fields: fields.flatMap((f) => f ? [f.key] : []), ...(row.result?.viewId ? { view: row.result.viewId } : {}) } : null };
}
