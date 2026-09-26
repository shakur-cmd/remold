import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getPrincipal, requireWriter } from "./identity";
import { unrestrictedHuman } from './authority/inbox';
import { writable } from './authority/readonly';
import { fail } from "./errors";

export const create = mutation({ args: { orgId: v.id("orgs"), role: v.union(v.literal("admin"), v.literal("member")) }, handler: async (ctx, args) => {
  const member = await requireWriter(ctx, args.orgId, "admin");
  if (!unrestrictedHuman(member)) fail('FORBIDDEN', 'Unrestricted workspace access required');
  const token = crypto.randomUUID(), expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  await ctx.db.insert("invites", { orgId: args.orgId, token, role: args.role, createdBy: member.user._id, issuerMembershipId: member.member._id, issuerEpoch: member.member.authorityEpoch ?? 0, expiresAt });
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
  await writable(ctx, invite.orgId);
  const issuer = await ctx.db.query('members').withIndex('by_org_user', q => q.eq('orgId', invite.orgId).eq('userId', invite.createdBy)).unique();
  if (!issuer || (invite.issuerMembershipId ? issuer._id !== invite.issuerMembershipId || (issuer.authorityEpoch ?? 0) !== invite.issuerEpoch : issuer._creationTime > invite._creationTime) || issuer.role === 'member' || issuer.readScopes !== undefined || issuer.hiddenFieldIds?.length) fail('FORBIDDEN', 'Invitation issuer no longer has unrestricted administrator access');
  if (invite.expiresAt < Date.now() || invite.acceptedAt) fail("INVITE_EXPIRED", "Invite expired");
  await ctx.db.insert("members", { orgId: invite.orgId, userId: principal.user._id, role: invite.role });
  await ctx.db.patch(invite._id, { acceptedBy: principal.user._id, acceptedAt: Date.now() });
  return invite.orgId;
} });
