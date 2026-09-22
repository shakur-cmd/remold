import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getPrincipal, requireMember } from "./identity";
import { seedStandard } from "./lib/standard";

export const create = mutation({ args: { name: v.string() }, handler: async (ctx, args) => {
  const principal = await getPrincipal(ctx);
  const orgId = await ctx.db.insert("orgs", { name: args.name, createdBy: principal.user._id });
  await ctx.db.insert("members", { orgId, userId: principal.user._id, role: "owner" });
  await seedStandard(ctx, orgId);
  return orgId;
} });
export const mine = query({ args: {}, handler: async (ctx) => {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return [];
  const user = await ctx.db.query("users").withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier)).unique();
  if (!user) return [];
  const members = await ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", user._id)).collect();
  const orgs = await Promise.all(members.map(async (member) => ({ org: await ctx.db.get(member.orgId), role: member.role })));
  return orgs.flatMap(({ org, role }) => (org ? [{ org, role }] : []));
} });
export const get = query({ args: { orgId: v.id("orgs") }, handler: async (ctx, args) => (await requireMember(ctx, args.orgId)).org });
export const rename = mutation({ args: { orgId: v.id("orgs"), name: v.string() }, handler: async (ctx, args) => { await requireMember(ctx, args.orgId, "admin"); await ctx.db.patch(args.orgId, { name: args.name }); } });
export const members = query({ args: { orgId: v.id("orgs") }, handler: async (ctx, args) => {
  await requireMember(ctx, args.orgId);
  const members = await ctx.db.query("members").withIndex("by_org_user", (q) => q.eq("orgId", args.orgId)).collect();
  return Promise.all(members.map(async (member) => { const user = await ctx.db.get(member.userId); return user ? [{ member, user: { _id: user._id, name: user.name, email: user.email, imageUrl: user.imageUrl } }] : []; })).then((rows) => rows.flat());
} });
