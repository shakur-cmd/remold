import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getPrincipal, requireMember } from "./identity";
import { fail } from "./errors";

export const create = mutation({ args: { orgId: v.id("orgs"), role: v.union(v.literal("admin"), v.literal("member")) }, handler: async (ctx, args) => {
  const member = await requireMember(ctx, args.orgId, "admin");
  const token = crypto.randomUUID(), expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  await ctx.db.insert("invites", { orgId: args.orgId, token, role: args.role, createdBy: member.user._id, expiresAt });
  return { token, expiresAt };
} });
export const get = query({ args: { token: v.string() }, handler: async (ctx, args) => {
  const invite = await ctx.db.query("invites").withIndex("by_token", (q) => q.eq("token", args.token)).unique();
  if (!invite) return null;
  const org = await ctx.db.get(invite.orgId);
  return org ? { orgName: org.name, role: invite.role, expired: invite.expiresAt < Date.now() || !!invite.acceptedAt } : null;
} });
export const accept = mutation({ args: { token: v.string() }, handler: async (ctx, args) => {
  const principal = await getPrincipal(ctx);
  const invite = await ctx.db.query("invites").withIndex("by_token", (q) => q.eq("token", args.token)).unique();
  if (!invite) fail("NOT_FOUND", "Invite not found");
  const existing = await ctx.db.query("members").withIndex("by_org_user", (q) => q.eq("orgId", invite.orgId).eq("userId", principal.user._id)).unique();
  if (existing) return invite.orgId;
  if (invite.expiresAt < Date.now() || invite.acceptedAt) fail("INVITE_EXPIRED", "Invite expired");
  await ctx.db.insert("members", { orgId: invite.orgId, userId: principal.user._id, role: invite.role });
  await ctx.db.patch(invite._id, { acceptedBy: principal.user._id, acceptedAt: Date.now() });
  return invite.orgId;
} });
