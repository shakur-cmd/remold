import { mutation, query, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { getPrincipal, requireMember } from "./identity";
import { seedStandard } from "./lib/standard";
import { fail } from "./errors";

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

const role = v.union(v.literal("owner"), v.literal("admin"), v.literal("member"));

async function memberOf(ctx: MutationCtx, orgId: Id<"orgs">, userId: Id<"users">) {
  const member = await ctx.db.query("members").withIndex("by_org_user", (q) => q.eq("orgId", orgId).eq("userId", userId)).unique();
  if (!member) fail("NOT_FOUND", "Not a member");
  return member;
}
// An org always keeps one owner, so nobody can lock everyone out.
async function keepAnOwner(ctx: MutationCtx, orgId: Id<"orgs">, leaving: Doc<"members">) {
  if (leaving.role !== "owner") return;
  const members = await ctx.db.query("members").withIndex("by_org_user", (q) => q.eq("orgId", orgId)).collect();
  if (!members.some((m) => m.role === "owner" && m._id !== leaving._id)) fail("VALIDATION", "Make someone else an owner first");
}
export const setRole = mutation({ args: { orgId: v.id("orgs"), userId: v.id("users"), role }, handler: async (ctx, args) => {
  const { member: me } = await requireMember(ctx, args.orgId, "admin");
  const target = await memberOf(ctx, args.orgId, args.userId);
  if ((target.role === "owner" || args.role === "owner") && me.role !== "owner") fail("FORBIDDEN", "Only an owner can change owners");
  if (args.role !== "owner") await keepAnOwner(ctx, args.orgId, target);
  await ctx.db.patch(target._id, { role: args.role });
} });
export const removeMember = mutation({ args: { orgId: v.id("orgs"), userId: v.id("users") }, handler: async (ctx, args) => {
  const { member: me } = await requireMember(ctx, args.orgId, "admin");
  const target = await memberOf(ctx, args.orgId, args.userId);
  if (target.role === "owner" && me.role !== "owner") fail("FORBIDDEN", "Only an owner can remove an owner");
  await keepAnOwner(ctx, args.orgId, target);
  await ctx.db.delete(target._id);
} });
export const leave = mutation({ args: { orgId: v.id("orgs") }, handler: async (ctx, args) => {
  const { member } = await requireMember(ctx, args.orgId);
  await keepAnOwner(ctx, args.orgId, member);
  await ctx.db.delete(member._id);
} });
