import { mutation, query, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { v } from "convex/values";
import { requireMember } from "./identity";
import { fail } from "./errors";
import { applyChange } from "./lib/applyChange";

const same = (left: unknown, right: unknown) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

async function row(ctx: QueryCtx, suggestion: Doc<"suggestions">) {
  const [agent, object, record] = await Promise.all([ctx.db.get(suggestion.agentId), ctx.db.get(suggestion.change.objectId), suggestion.change.recordId ? ctx.db.get(suggestion.change.recordId) : null]);
  return { suggestion, agentName: agent?.name ?? null, objectKey: object?.key ?? null, objectLabel: object?.label ?? null, recordTitle: record?.title ?? null, recordRef: record?.ref ?? null };
}

export const list = query({ args: { orgId: v.id("orgs"), status: v.optional(v.union(v.literal("pending"), v.literal("applied"), v.literal("dismissed"), v.literal("conflicted"))) }, handler: async (ctx, args) => {
  await requireMember(ctx, args.orgId);
  const rows = await ctx.db.query("suggestions").withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", args.status ?? "pending")).order("desc").take(200);
  return Promise.all(rows.map((suggestion) => row(ctx, suggestion)));
} });

export const forRecord = query({ args: { orgId: v.id("orgs"), recordId: v.id("records") }, handler: async (ctx, args) => {
  await requireMember(ctx, args.orgId);
  const rows = await ctx.db.query("suggestions").withIndex("by_record", (q) => q.eq("orgId", args.orgId).eq("recordId", args.recordId)).order("desc").collect();
  return Promise.all(rows.filter((suggestion) => suggestion.status === "pending" || suggestion.status === "conflicted").map((suggestion) => row(ctx, suggestion)));
} });

export const apply = mutation({ args: { orgId: v.id("orgs"), suggestionId: v.id("suggestions") }, handler: async (ctx, args) => {
  const member = await requireMember(ctx, args.orgId);
  const suggestion = await ctx.db.get(args.suggestionId);
  if (!suggestion || suggestion.orgId !== args.orgId) fail("NOT_FOUND", "Suggestion not found");
  if (suggestion.status !== "pending") return { status: "already" as const, current: suggestion.status };
  let record = suggestion.change.recordId ? await ctx.db.get(suggestion.change.recordId) : null;
  if (suggestion.change.action !== "create" && (!record || record.orgId !== args.orgId)) {
    const conflicts = [{ fieldId: "*", expected: suggestion.before, actual: null }];
    await ctx.db.patch(suggestion._id, { status: "conflicted", conflicts });
    return { status: "conflicted" as const, conflicts };
  }
  if (suggestion.change.action === "update") {
    const conflicts = Object.keys(suggestion.change.values).flatMap((fieldId) => same(record!.values[fieldId], suggestion.before[fieldId]) ? [] : [{ fieldId, expected: suggestion.before[fieldId] ?? null, actual: record!.values[fieldId] ?? null }]);
    if (conflicts.length) { await ctx.db.patch(suggestion._id, { status: "conflicted", conflicts }); return { status: "conflicted" as const, conflicts }; }
  }
  const agent = await ctx.db.get(suggestion.agentId), org = await ctx.db.get(args.orgId);
  if (!agent || !org) fail("NOT_FOUND", "Suggestion agent not found");
  const change = suggestion.change.action === "create"
    ? { action: "create" as const, orgId: args.orgId, objectId: suggestion.change.objectId, values: suggestion.change.values, reason: suggestion.reason }
    : suggestion.change.action === "update"
      ? { action: "update" as const, orgId: args.orgId, recordId: suggestion.change.recordId!, values: suggestion.change.values, reason: suggestion.reason }
      : { action: "delete" as const, orgId: args.orgId, recordId: suggestion.change.recordId!, reason: suggestion.reason };
  const result = await applyChange(ctx, { agent, org, actor: { kind: "agent", id: agent._id } }, change, { suggestionId: suggestion._id });
  await ctx.db.patch(suggestion._id, { status: "applied", resolvedBy: member.user._id, resolvedAt: Date.now(), ...(result.eventId ? { eventId: result.eventId } : {}) });
  if (suggestion.inboxId) { const inbox = await ctx.db.get(suggestion.inboxId); if (inbox?.orgId === args.orgId && inbox.status === "pending") await ctx.db.patch(inbox._id, { status: "resolved", resolvedAt: Date.now(), suggestionId: suggestion._id }); }
  return { status: "applied" as const, recordId: result.recordId, eventId: result.eventId };
} });

export const dismiss = mutation({ args: { orgId: v.id("orgs"), suggestionId: v.id("suggestions") }, handler: async (ctx, args) => {
  const member = await requireMember(ctx, args.orgId), suggestion = await ctx.db.get(args.suggestionId);
  if (!suggestion || suggestion.orgId !== args.orgId) fail("NOT_FOUND", "Suggestion not found");
  if (suggestion.status !== "pending" && suggestion.status !== "conflicted") return { status: "already" as const };
  await ctx.db.patch(suggestion._id, { status: "dismissed", resolvedBy: member.user._id, resolvedAt: Date.now() });
  return { status: "dismissed" as const };
} });
