import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireWriter, requireMember } from "./identity";
import { fail } from "./errors";
import { unrestrictedHuman, canSeeInbox, visibleInbox } from './authority/inbox';
import { visibleInboxItems } from './authority/pending';

export const audience = query({ args: { orgId: v.id('orgs') }, handler: async (ctx, args) => ({ canShare: unrestrictedHuman(await requireMember(ctx, args.orgId)) }) });

export const list = query({ args: { orgId: v.id("orgs"), status: v.optional(v.union(v.literal("pending"), v.literal("resolved"))) }, handler: async (ctx, args) => {
  const principal = await requireMember(ctx, args.orgId);
  const rows = await visibleInboxItems(ctx, principal, args.status ?? "pending", 100);
  return (await Promise.all(rows.map(row => visibleInbox(ctx, principal, row)))).filter((row): row is NonNullable<typeof row> => row !== null);
} });

export const add = mutation({ args: { orgId: v.id("orgs"), text: v.string(), source: v.optional(v.string()), shareWithAgents: v.optional(v.boolean()) }, handler: async (ctx, args) => {
  const member = await requireWriter(ctx, args.orgId);
  if (!args.text.trim()) fail("VALIDATION", "Inbox text is required");
  if (args.shareWithAgents && !unrestrictedHuman(member)) fail('FORBIDDEN', 'Unrestricted workspace access is required to share free text');
  return ctx.db.insert("agentInbox", { orgId: args.orgId, text: args.text.trim(), source: args.source ?? "api", from: { kind: "user", id: member.user._id }, status: "pending", audience: args.shareWithAgents ? 'org' : 'author' });
} });

export const remove = mutation({ args: { orgId: v.id("orgs"), id: v.id("agentInbox") }, handler: async (ctx, args) => {
  const principal = await requireWriter(ctx, args.orgId);
  const item = await ctx.db.get(args.id);
  if (!item || !canSeeInbox(principal, item)) fail("NOT_FOUND", "Inbox item not found");
  await ctx.db.delete(item._id);
} });
