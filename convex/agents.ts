import { action, internalMutation, mutation, query } from "./_generated/server";
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
  const key = `rm_${hex(crypto.getRandomValues(new Uint8Array(20)))}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return ctx.runMutation(internal.agents.insert, { ...args, key, keyHash: hex(new Uint8Array(digest)) });
} });

export const insert = internalMutation({ args: { orgId: v.id("orgs"), name: v.string(), role: v.optional(role), grants: v.optional(grants), key: v.string(), keyHash: v.string() }, handler: async (ctx, args) => {
  const member = await requireMember(ctx, args.orgId, "admin");
  if (!args.name.trim()) fail("VALIDATION", "Agent name is required");
  const agentId = await ctx.db.insert("agents", { orgId: args.orgId, name: args.name.trim(), role: args.role ?? "member", createdBy: member.user._id, keyHash: args.keyHash, keyPrefix: args.key.slice(0, 12), grants: args.grants ?? [] });
  return { agentId, key: args.key };
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
