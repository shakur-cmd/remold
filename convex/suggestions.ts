import { mutation, query, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { v } from "convex/values";
import { requireWriter, requireMember, type Principal } from "./identity";
import { fail } from "./errors";
import { applyChange } from "./lib/applyChange";
import { canReadRecordId, canReadField, requireObjectRead, requireRecordRead, visibleTitle } from "./authority/reads";

const same = (left: unknown, right: unknown) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

async function row(ctx: QueryCtx, principal: Principal, suggestion: Doc<"suggestions">) {
  const [agent, object, record] = await Promise.all([ctx.db.get(suggestion.agentId), ctx.db.get(suggestion.change.objectId), suggestion.change.recordId ? ctx.db.get(suggestion.change.recordId) : null]);
  if (!object || !canReadRecordId(principal, object, suggestion.change.recordId)) return null;
  const fields = await ctx.db.query("fields").withIndex("by_object", q => q.eq("orgId", principal.org._id).eq("objectId", object._id)).collect();
  const visible = new Set(fields.filter(f => canReadField(principal, object, f, suggestion.change.recordId)).map(f => String(f._id)));
  const mask = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).filter(([id]) => visible.has(id)));
  return { suggestion: { ...suggestion, before: mask(suggestion.before), change: { ...suggestion.change, values: mask(suggestion.change.values) }, conflicts: suggestion.conflicts?.filter(c => visible.has(c.fieldId)), reason: visible.size === fields.length ? suggestion.reason : "" }, agentName: agent?.name ?? null, objectKey: object.key, objectLabel: object.label, recordTitle: record ? await visibleTitle(ctx, principal, record) : null, recordRef: record?.ref ?? null, paused: !suggestion.adoptedBy && (!agent || agent.revokedAt !== undefined || (agent.state !== undefined && agent.state !== "active") || (agent.authorityEpoch ?? 0) !== (suggestion.authorityEpoch ?? 0)) };
}

export const list = query({ args: { orgId: v.id("orgs"), status: v.optional(v.union(v.literal("pending"), v.literal("applied"), v.literal("dismissed"), v.literal("conflicted"))) }, handler: async (ctx, args) => {
  const principal = await requireMember(ctx, args.orgId);
  const rows = await ctx.db.query("suggestions").withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", args.status ?? "pending")).order("desc").take(200);
  return (await Promise.all(rows.map((suggestion) => row(ctx, principal, suggestion)))).filter((value): value is NonNullable<typeof value> => value !== null);
} });

export const forRecord = query({ args: { orgId: v.id("orgs"), recordId: v.id("records") }, handler: async (ctx, args) => {
  const principal = await requireMember(ctx, args.orgId);
  const rows = await ctx.db.query("suggestions").withIndex("by_record", (q) => q.eq("orgId", args.orgId).eq("recordId", args.recordId)).order("desc").collect();
  return (await Promise.all(rows.filter((suggestion) => suggestion.status === "pending" || suggestion.status === "conflicted").map((suggestion) => row(ctx, principal, suggestion)))).filter((value): value is NonNullable<typeof value> => value !== null);
} });

export const apply = mutation({ args: { orgId: v.id("orgs"), suggestionId: v.id("suggestions") }, handler: async (ctx, args) => {
  const member = await requireWriter(ctx, args.orgId);
  const suggestion = await ctx.db.get(args.suggestionId);
  if (!suggestion || suggestion.orgId !== args.orgId) fail("NOT_FOUND", "Suggestion not found");
  const projected = await row(ctx, member, suggestion); if (!projected) fail("NOT_FOUND", "Suggestion not found");
  if (suggestion.status !== "pending") return { status: "already" as const, current: suggestion.status };
  let record = suggestion.change.recordId ? await ctx.db.get(suggestion.change.recordId) : null;
  if (suggestion.change.action !== "create" && (!record || record.orgId !== args.orgId)) {
    const conflicts = [{ fieldId: "*", expected: projected.suggestion.before, actual: null }];
    await ctx.db.patch(suggestion._id, { status: "conflicted", conflicts });
    return { status: "conflicted" as const, conflicts };
  }
  const object = await ctx.db.get(suggestion.change.objectId);
  if (!object) fail("NOT_FOUND"); requireObjectRead(member, object);
  if (record) requireRecordRead(member, object, record);
  for (const id of Object.keys(suggestion.change.values)) {
    const fieldId = ctx.db.normalizeId("fields", id), field = fieldId ? await ctx.db.get(fieldId) : null;
    if (!field || !canReadField(member, object, field, record?._id)) fail("NOT_FOUND", "Field not found");
  }
  if (suggestion.change.action === "update") {
    const conflicts = Object.keys(suggestion.change.values).flatMap((fieldId) => same(record!.values[fieldId], suggestion.before[fieldId]) ? [] : [{ fieldId, expected: suggestion.before[fieldId] ?? null, actual: record!.values[fieldId] ?? null }]);
    if (conflicts.length) { await ctx.db.patch(suggestion._id, { status: "conflicted", conflicts }); return { status: "conflicted" as const, conflicts }; }
  }
  const agent = await ctx.db.get(suggestion.agentId), org = await ctx.db.get(args.orgId);
  if (!agent || !org) fail("NOT_FOUND", "Suggestion agent not found");
  if (!suggestion.adoptedBy && (agent.revokedAt !== undefined || (agent.state !== undefined && agent.state !== "active") || (agent.authorityEpoch ?? 0) !== (suggestion.authorityEpoch ?? 0))) fail("FORBIDDEN", "Agent access was revoked; adopt this suggestion as a new human action");
  const change = suggestion.change.action === "create"
    ? { action: "create" as const, orgId: args.orgId, objectId: suggestion.change.objectId, values: suggestion.change.values, reason: suggestion.reason }
    : suggestion.change.action === "update"
      ? { action: "update" as const, orgId: args.orgId, recordId: suggestion.change.recordId!, values: suggestion.change.values, reason: suggestion.reason }
      : { action: "delete" as const, orgId: args.orgId, recordId: suggestion.change.recordId!, reason: suggestion.reason };
  if (suggestion.adoptedBy && (suggestion.adoptedBy !== member.user._id || (suggestion.authorityEpoch ?? 0) !== (member.member.authorityEpoch ?? 0))) fail("FORBIDDEN", "Only the adopting member can apply this action");
  const result = await applyChange(ctx, suggestion.adoptedBy ? member : { agent, org, actor: { kind: "agent", id: agent._id } }, change, { suggestionId: suggestion._id, approvedBy: member });
  await ctx.db.patch(suggestion._id, { status: "applied", resolvedBy: member.user._id, resolvedAt: Date.now(), ...(result.eventId ? { eventId: result.eventId } : {}) });
  if (suggestion.inboxId) { const inbox = await ctx.db.get(suggestion.inboxId); if (inbox?.orgId === args.orgId && inbox.status === "pending") await ctx.db.patch(inbox._id, { status: "resolved", resolvedAt: Date.now(), suggestionId: suggestion._id }); }
  return { status: "applied" as const, recordId: result.recordId, eventId: result.eventId };
} });

export const dismiss = mutation({ args: { orgId: v.id("orgs"), suggestionId: v.id("suggestions") }, handler: async (ctx, args) => {
  const member = await requireMember(ctx, args.orgId), suggestion = await ctx.db.get(args.suggestionId);
  if (!suggestion || suggestion.orgId !== args.orgId) fail("NOT_FOUND", "Suggestion not found");
  if (!await row(ctx, member, suggestion)) fail("NOT_FOUND", "Suggestion not found");
  if (suggestion.status !== "pending" && suggestion.status !== "conflicted") return { status: "already" as const };
  await ctx.db.patch(suggestion._id, { status: "dismissed", resolvedBy: member.user._id, resolvedAt: Date.now() });
  return { status: "dismissed" as const };
} });

export const adopt = mutation({ args: { orgId: v.id("orgs"), suggestionId: v.id("suggestions") }, handler: async (ctx, args) => {
  const member = await requireWriter(ctx, args.orgId), source = await ctx.db.get(args.suggestionId);
  if (!source || source.orgId !== args.orgId || !["pending", "conflicted"].includes(source.status)) fail("NOT_FOUND", "Suggestion cannot be adopted");
  if (!await row(ctx, member, source)) fail("NOT_FOUND", "Suggestion cannot be adopted");
  const { _id, _creationTime, resolvedBy, resolvedAt, eventId, conflicts, ...content } = source;
  return ctx.db.insert("suggestions", { ...content, status: "pending", adoptedFrom: _id, adoptedBy: member.user._id, authorityEpoch: member.member.authorityEpoch ?? 0 });
} });
