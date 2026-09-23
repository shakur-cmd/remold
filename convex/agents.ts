import { action, internalAction, internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { requireMember } from "./identity";
import { fail } from "./errors";

const grants = v.array(v.object({ action: v.union(v.literal("create"), v.literal("update"), v.literal("delete")), objectKey: v.string() }));
const role = v.union(v.literal("admin"), v.literal("member"));
const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export const list = query({ args: { orgId: v.id("orgs") }, handler: async (ctx, args) => {
  await requireMember(ctx, args.orgId);
  return ctx.db.query("agents").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).collect().then((rows) => rows.map(({ keyHash: _keyHash, ...agent }) => agent));
} });

// The key is minted here, in an action, because mutations have no
// crypto.subtle. Only its hash reaches the database; the plain key goes back
// to the admin once. The explicit return type breaks the internal.* type cycle.
export const create = action({ args: { orgId: v.id("orgs"), name: v.string(), role: v.optional(role), grants: v.optional(grants) }, handler: async (ctx, args): Promise<{ agentId: Id<"agents">; key: string }> => {
  return ctx.runMutation(internal.agents.insert, { ...args, ...(await mint()) });
} });

const mint = async () => {
  const key = `rm_${hex(crypto.getRandomValues(new Uint8Array(20)))}`;
  return { key, keyHash: hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)))) };
};

export const insert = internalMutation({ args: { orgId: v.id("orgs"), name: v.string(), role: v.optional(role), grants: v.optional(grants), key: v.string(), keyHash: v.string(), asUserId: v.optional(v.id("users")) }, handler: async (ctx, args) => {
  // CLI creation (`convex run agents:createAs`) has no signed-in identity, so
  // the admin is named explicitly, the same way seed:demoAs works.
  const userId = args.asUserId ? await adminId(ctx, args.orgId, args.asUserId) : (await requireMember(ctx, args.orgId, "admin")).user._id;
  if (!args.name.trim()) fail("VALIDATION", "Agent name is required");
  const agentId = await ctx.db.insert("agents", { orgId: args.orgId, name: args.name.trim(), role: args.role ?? "member", createdBy: userId, keyHash: args.keyHash, keyPrefix: args.key.slice(0, 12), grants: args.grants ?? [] });
  return { agentId, key: args.key };
} });

async function adminId(ctx: { db: any }, orgId: Id<"orgs">, userId: Id<"users">) {
  const member = await ctx.db.query("members").withIndex("by_org_user", (q: any) => q.eq("orgId", orgId).eq("userId", userId)).unique();
  if (!member || member.role === "member") fail("FORBIDDEN", "Admin membership required");
  return userId;
}

export const createAs = internalAction({ args: { orgId: v.id("orgs"), userId: v.id("users"), name: v.string(), role: v.optional(role), grants: v.optional(grants) }, handler: async (ctx, args): Promise<{ agentId: Id<"agents">; key: string }> => {
  const { userId, ...rest } = args;
  return ctx.runMutation(internal.agents.insert, { ...rest, ...(await mint()), asUserId: userId });
} });

export const setGrants = mutation({ args: { orgId: v.id("orgs"), agentId: v.id("agents"), grants }, handler: async (ctx, args) => {
  await requireMember(ctx, args.orgId, "admin");
  const agent = await ctx.db.get(args.agentId);
  if (!agent || agent.orgId !== args.orgId) fail("NOT_FOUND", "Agent not found");
  await ctx.db.patch(agent._id, { grants: args.grants });
} });

export const revoke = mutation({ args: { orgId: v.id("orgs"), agentId: v.id("agents") }, handler: async (ctx, args) => {
  await requireMember(ctx, args.orgId, "admin");
  const agent = await ctx.db.get(args.agentId);
  if (!agent || agent.orgId !== args.orgId) fail("NOT_FOUND", "Agent not found");
  await ctx.db.patch(agent._id, { revokedAt: Date.now() });
} });
