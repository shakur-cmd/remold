import { pauseWork } from './integrations/lifecycle';
import { action, internalAction, internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { v, type ObjectType } from "convex/values";
import { memberAs, requireMember } from "./identity";
import { fail } from "./errors";
import { expand, snapshot } from "./authority/migration";
import { writable } from "./authority/readonly";
import { grantIntake } from "./lib/intake";
import { issue } from "./authority/grants";

const grants = v.array(v.object({ action: v.union(v.literal("create"), v.literal("update"), v.literal("delete")), objectKey: v.string() }));
const role = v.union(v.literal("admin"), v.literal("member"));
const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export const list = query({ args: { orgId: v.id("orgs") }, handler: async (ctx, args) => {
  await requireMember(ctx, args.orgId);
  // Scoped keys act only through capability grants; access names the live ones, e.g. "create activity".
  const keys = new Map((await ctx.db.query("objects").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).collect()).map((o) => [o._id as string, o.key])), now = Date.now();
  const rows = await ctx.db.query("agents").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).collect();
  return Promise.all(rows.map(async ({ keyHash: _keyHash, ...agent }) => {
    const live = (await ctx.db.query("capabilityGrants").withIndex("by_agent", (q) => q.eq("orgId", args.orgId).eq("agentId", agent._id)).collect()).filter((g) => g.revokedAt === undefined && g.expiresAt > now);
    return { ...agent, grants: agent.grants.map(({ action, objectKey }) => ({ action, objectKey })), access: [...new Set(live.map((g) => `${g.capability.replace(/^record\./, "")}${g.scope.kind === "records" ? ` ${keys.get(g.scope.objectId) ?? "?"}` : ""}`))] };
  }));
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

const insertArgs = { orgId: v.id("orgs"), name: v.string(), role: v.optional(role), grants: v.optional(grants), scoped: v.optional(v.boolean()), intake: v.optional(v.boolean()), origin: v.optional(v.union(v.literal("hosted"), v.literal("external"))), keyHash: v.string(), keyPrefix: v.string(), asUserId: v.optional(v.id("users")) };
export const insert = internalMutation({ args: insertArgs, handler: (ctx, args) => insertAgent(ctx, args) });
async function insertAgent(ctx: MutationCtx, args: ObjectType<typeof insertArgs>): Promise<Id<"agents">> {
  // CLI creation (`convex run agents:createAs`, or agents:insert for the intake key) has no signed-in identity, so
  // the admin is named explicitly, the same way seed:demoAs works.
  const userId = args.asUserId ? (await memberAs(ctx, args.orgId, args.asUserId, "admin")).user._id : (await requireMember(ctx, args.orgId, "admin")).user._id;
  if (!args.name.trim()) fail("VALIDATION", "Agent name is required");
  await writable(ctx, args.orgId);
  if (!args.scoped) await legacyCeiling(ctx, args.orgId, userId);
  const objects = await snapshot(ctx, args.orgId);
  const agentId = await ctx.db.insert("agents", { orgId: args.orgId, name: args.name.trim(), role: args.role ?? "member", createdBy: userId, keyHash: args.keyHash, keyPrefix: args.keyPrefix, grants: expand(args.grants ?? [], objects), readObjectIds: args.scoped ? [] : objects.map(o => o._id), authorityVersion: 1, origin: args.origin ?? "external", state: "active", authorityEpoch: 0, ...(args.intake ? { purpose: "intake" as const } : {}) });
  await ctx.db.insert("authorityAudit", { orgId: args.orgId, actor: { kind: "user", id: userId }, action: args.scoped ? "scopedAgentCreated" : "legacyGrantsFrozen", targetId: agentId, objectIds: args.scoped ? [] : objects.map(o => o._id), epoch: 0 });
  if (args.intake) await grantIntake(ctx, args.orgId, agentId, args.asUserId);
  return agentId;
}

async function legacyCeiling(ctx: { db: any }, orgId: Id<"orgs">, userId: Id<"users">) {
  const member = await ctx.db.query("members").withIndex("by_org_user", (q: any) => q.eq("orgId", orgId).eq("userId", userId)).unique();
  if (!member || member.readScopes !== undefined || member.hiddenFieldIds?.length) fail("FORBIDDEN", "Restricted administrators must use createScoped and bounded grants");
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

// The website's lead key: it reads nothing and can only call POST /api/v1/intake/lead.
export const createIntake = action({ args: { orgId: v.id("orgs") }, handler: async (ctx, args): Promise<{ agentId: Id<"agents">; key: string }> => {
  const { key, ...stored } = await mint();
  return { agentId: await ctx.runMutation(internal.agents.insert, { ...args, ...stored, name: "Website intake key", origin: "external", scoped: true, intake: true }), key };
} });

// Preset for ops/gmail-sync: a scoped key that reads only people's names and
// emails and creates activities. Creating needs read on the fields it writes,
// so it also reads those five Activity fields. Capability grants must expire.
const GMAIL_SYNC = { person: ["name", "email"], activity: ["title", "type", "when", "about", "source"] };
export const createGmailSync = action({ args: { orgId: v.id("orgs") }, handler: async (ctx, args): Promise<{ agentId: Id<"agents">; key: string }> => {
  const { key, ...stored } = await mint();
  return { agentId: await ctx.runMutation(internal.agents.insertGmailSync, { ...args, ...stored }), key };
} });
export const insertGmailSync = internalMutation({ args: { orgId: v.id("orgs"), keyHash: v.string(), keyPrefix: v.string() }, handler: async (ctx, args): Promise<Id<"agents">> => {
  const owner = await requireMember(ctx, args.orgId, "owner");
  const agentId = await insertAgent(ctx, { ...args, name: "Gmail sync", scoped: true, origin: "external" });
  const expiresAt = Date.now() + 365 * 86400000;
  for (const [objectKey, keys] of Object.entries(GMAIL_SYNC)) {
    const object = await ctx.db.query("objects").withIndex("by_org_key", (q) => q.eq("orgId", args.orgId).eq("key", objectKey)).unique();
    const fields = object ? await ctx.db.query("fields").withIndex("by_object", (q) => q.eq("orgId", args.orgId).eq("objectId", object._id)).collect() : [];
    const ids = keys.map((key) => fields.find((field) => field.key === key && !field.retired)?._id);
    if (!object || ids.some((id) => !id)) fail("NOT_FOUND", `${objectKey} is missing a field the Gmail sync needs`);
    const scope = { kind: "records" as const, objectId: object._id, records: "all" as const, fields: ids as Id<"fields">[] };
    await issue(ctx, owner, { target: agentId, capability: "read", scope, mode: "direct", delegate: false, expiresAt });
    if (objectKey === "activity") await issue(ctx, owner, { target: agentId, capability: "record.create", scope, mode: "direct", delegate: false, expiresAt });
  }
  return agentId;
} });
