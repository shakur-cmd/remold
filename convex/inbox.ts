import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireMember } from "./identity";
import { fail } from "./errors";

export const list = query({ args: { orgId: v.id("orgs"), status: v.optional(v.union(v.literal("pending"), v.literal("resolved"))) }, handler: async (ctx, args) => {
  await requireMember(ctx, args.orgId);
  return ctx.db.query("agentInbox").withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", args.status ?? "pending")).order("asc").take(100);
} });

export const add = mutation({ args: { orgId: v.id("orgs"), text: v.string(), source: v.optional(v.string()) }, handler: async (ctx, args) => {
  const member = await requireMember(ctx, args.orgId);
  if (!args.text.trim()) fail("VALIDATION", "Inbox text is required");
  return ctx.db.insert("agentInbox", { orgId: args.orgId, text: args.text.trim(), source: args.source ?? "api", from: { kind: "user", id: member.user._id }, status: "pending" });
} });

export const remove = mutation({ args: { orgId: v.id("orgs"), id: v.id("agentInbox") }, handler: async (ctx, args) => {
  await requireMember(ctx, args.orgId);
  const item = await ctx.db.get(args.id);
  if (!item || item.orgId !== args.orgId) fail("NOT_FOUND", "Inbox item not found");
  await ctx.db.delete(item._id);
} });
