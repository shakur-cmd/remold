import { pauseWork } from './integrations/lifecycle';
import { action, internalAction, internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { requireMember } from "./identity";
import { fail } from "./errors";
import { expand, snapshot } from "./authority/migration";
import { writable } from "./authority/readonly";

const grants = v.array(v.object({ action: v.union(v.literal("create"), v.literal("update"), v.literal("delete")), objectKey: v.string() }));
const role = v.union(v.literal("admin"), v.literal("member"));
const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export const list = query({ args: { orgId: v.id("orgs") }, handler: async (ctx, args) => {
  await requireMember(ctx, args.orgId);
  return ctx.db.query("agents").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).collect().then((rows) => rows.map(({ keyHash: _keyHash, ...agent }) => ({ ...agent, grants: agent.grants.map(({ action, objectKey }) => ({ action, objectKey })) })));
} });

// The key is minted here, in an action, because mutations have no
// crypto.subtle. Only the hash and a display prefix are passed on; the plain
// key goes back to the admin once. The explicit return type breaks the
// internal.* type cycle.
export const create = action({ args: { orgId: v.id("orgs"), name: v.string(), role: v.optional(role), grants: v.optional(grants) }, handler: async (ctx, args): Promise<{ agentId: Id<"agents">; key: string }> => {
  const { key, ...stored } = await mint();
  return { agentId: await ctx.runMutation(internal.agents.insert, { ...args, ...stored }), key };
} });

const mint = async () => {
  const key = `rm_${hex(crypto.getRandomValues(new Uint8Array(20)))}`;
  return { key, keyHash: hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)))), keyPrefix: key.slice(0, 12) };
};

export const insert = internalMutation({ args: { orgId: v.id("orgs"), name: v.string(), role: v.optional(role), grants: v.optional(grants), scoped: v.optional(v.boolean()), origin: v.optional(v.union(v.literal("hosted"), v.literal("external"))), keyHash: v.string(), keyPrefix: v.string(), asUserId: v.optional(v.id("users")) }, handler: async (ctx, args): Promise<Id<"agents">> => {
  // CLI creation (`convex run agents:createAs`) has no signed-in identity, so
  // the admin is named explicitly, the same way seed:demoAs works.
  const userId = args.asUserId ? await adminId(ctx, args.orgId, args.asUserId) : (await requireMember(ctx, args.orgId, "admin")).user._id;
  if (!args.name.trim()) fail("VALIDATION", "Agent name is required");
  await writable(ctx, args.orgId);
  if (!args.scoped) await legacyCeiling(ctx, args.orgId, userId);
  const objects = await snapshot(ctx, args.orgId);
  const agentId = await ctx.db.insert("agents", { orgId: args.orgId, name: args.name.trim(), role: args.role ?? "member", createdBy: userId, keyHash: args.keyHash, keyPrefix: args.keyPrefix, grants: expand(args.grants ?? [], objects), readObjectIds: args.scoped ? [] : objects.map(o => o._id), authorityVersion: 1, origin: args.origin ?? "external", state: "active", authorityEpoch: 0 });
  await ctx.db.insert("authorityAudit", { orgId: args.orgId, actor: { kind: "user", id: userId }, action: args.scoped ? "scopedAgentCreated" : "legacyGrantsFrozen", targetId: agentId, objectIds: args.scoped ? [] : objects.map(o => o._id), epoch: 0 });
  return agentId;
} });

async function legacyCeiling(ctx: { db: any }, orgId: Id<"orgs">, userId: Id<"users">) {
  const member = await ctx.db.query("members").withIndex("by_org_user", (q: any) => q.eq("orgId", orgId).eq("userId", userId)).unique();
  if (!member || member.readScopes !== undefined || member.hiddenFieldIds?.length) fail("FORBIDDEN", "Restricted administrators must use createScoped and bounded grants");
}

async function adminId(ctx: { db: any }, orgId: Id<"orgs">, userId: Id<"users">) {
  const member = await ctx.db.query("members").withIndex("by_org_user", (q: any) => q.eq("orgId", orgId).eq("userId", userId)).unique();
  if (!member || member.role === "member") fail("FORBIDDEN", "Admin membership required");
  return userId;
}

export const createAs = internalAction({ args: { orgId: v.id("orgs"), userId: v.id("users"), name: v.string(), role: v.optional(role), grants: v.optional(grants) }, handler: async (ctx, args): Promise<{ agentId: Id<"agents">; key: string }> => {
  const { userId, ...rest } = args, { key, ...stored } = await mint();
  return { agentId: await ctx.runMutation(internal.agents.insert, { ...rest, ...stored, asUserId: userId }), key };
} });

export const setGrants = mutation({ args: { orgId: v.id("orgs"), agentId: v.id("agents"), grants }, handler: async (ctx, args) => {
  const caller = await requireMember(ctx, args.orgId, "admin");
  const agent = await ctx.db.get(args.agentId);
  if (!agent || agent.orgId !== args.orgId) fail("NOT_FOUND", "Agent not found");
  const objects = await snapshot(ctx, args.orgId);
  const frozen = await snapshot(ctx, args.orgId, caller.org.authorityFrozenAt), before = agent.authorityVersion === 1 ? agent.grants : expand(agent.grants, frozen), next = expand(args.grants, objects);
  if (next.some(g => !before.some(old => old.action === g.action && old.objectId === g.objectId))) { await writable(ctx, args.orgId); await legacyCeiling(ctx, args.orgId, caller.user._id); }
  await ctx.db.patch(agent._id, { grants: next, authorityVersion: 1, readObjectIds: agent.readObjectIds ?? frozen.map(o => o._id), authorityEpoch: (agent.authorityEpoch ?? 0) + 1 });
  await pauseWork(ctx, args.orgId);
  await ctx.db.insert("authorityAudit", { orgId: args.orgId, actor: caller.actor, action: "legacyGrantsReplaced", targetId: agent._id, objectIds: objects.map(o => o._id), epoch: (agent.authorityEpoch ?? 0) + 1 });
} });

export const revoke = mutation({ args: { orgId: v.id("orgs"), agentId: v.id("agents") }, handler: async (ctx, args) => {
  await requireMember(ctx, args.orgId, "admin");
  const agent = await ctx.db.get(args.agentId);
  if (!agent || agent.orgId !== args.orgId) fail("NOT_FOUND", "Agent not found");
  await ctx.db.patch(agent._id, { revokedAt: agent.revokedAt ?? Date.now(), state: "fired", authorityEpoch: (agent.authorityEpoch ?? 0) + 1 });
  await pauseWork(ctx, args.orgId);
} });

export const setSharedInbox = mutation({ args: { orgId: v.id('orgs'), agentId: v.id('agents'), enabled: v.boolean() }, handler: async (ctx, args) => {
  const caller = await requireMember(ctx, args.orgId, 'admin');
  if (args.enabled) { await writable(ctx, args.orgId); await legacyCeiling(ctx, args.orgId, caller.user._id); }
  const agent = await ctx.db.get(args.agentId); if (!agent || agent.orgId !== args.orgId) fail('NOT_FOUND');
  await ctx.db.patch(agent._id, { sharedInbox: args.enabled, authorityEpoch: (agent.authorityEpoch ?? 0) + 1 });
  await pauseWork(ctx, args.orgId);
  await ctx.db.insert('authorityAudit', { orgId: args.orgId, actor: caller.actor, action: 'sharedInboxChanged', targetId: agent._id, epoch: (agent.authorityEpoch ?? 0) + 1 });
} });

export const createScoped = action({ args: { orgId: v.id("orgs"), name: v.string(), origin: v.union(v.literal("hosted"), v.literal("external")) }, handler: async (ctx, args): Promise<{ agentId: Id<"agents">; key: string }> => {
  const { key, ...stored } = await mint();
  return { agentId: await ctx.runMutation(internal.agents.insert, { ...args, ...stored, scoped: true }), key };
} });
