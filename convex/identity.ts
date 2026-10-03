import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import { fail } from "./errors";
import { writable } from "./authority/readonly";
import { validGrants } from "./authority/grants";
import { frozenKey } from "./authority/migration";

export type Role = "owner" | "admin" | "member";
export type Actor = { kind: "user" | "agent" | "automation"; id: string };
export type UserPrincipal = { user: Doc<"users">; actor: { kind: "user"; id: string } };
export type Membership = UserPrincipal & { member: Doc<"members">; org: Doc<"orgs"> };
export type AgentMembership = { capabilities?: Doc<"capabilityGrants">[]; readsEverything?: boolean; agent: Doc<"agents">; org: Doc<"orgs">; actor: { kind: "agent"; id: string } };
export type Principal = Membership | AgentMembership;
type Ctx = QueryCtx | MutationCtx;
const rank: Record<Role, number> = { member: 0, admin: 1, owner: 2 };

export async function getPrincipal(ctx: Ctx): Promise<UserPrincipal> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) fail("UNAUTHENTICATED", "Sign in first");
  const user = await ctx.db.query("users").withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier)).unique();
  if (!user) fail("UNAUTHENTICATED", "Call users.store first");
  return { user, actor: { kind: "user", id: user._id } };
}

// A purpose key (the website intake key) works only on its own route.
export async function requireAgent(ctx: Ctx, keyHash: string, purpose?: "intake"): Promise<AgentMembership> {
  const agent = await ctx.db.query("agents").withIndex("by_key_hash", (q) => q.eq("keyHash", keyHash)).unique();
  if (!agent || agent.revokedAt !== undefined || (agent.state !== undefined && agent.state !== "active")) fail("UNAUTHENTICATED", "Invalid or revoked agent key");
  if (agent.purpose !== undefined && agent.purpose !== purpose) fail("FORBIDDEN", "This key can only submit website leads");
  const org = await ctx.db.get(agent.orgId);
  if (!org) fail("UNAUTHENTICATED", "Invalid or revoked agent key");
  if (agent.authorityVersion !== 1 && org.authorityFrozenAt === undefined) fail("AUTHORITY_MIGRATING", "Workspace authority migration is pending; retry shortly", { retryable: true });
  return { agent, org, capabilities: await validGrants(ctx, agent), readsEverything: await readsEverything(ctx, agent), actor: { kind: "agent", id: agent._id } };
}

// Whether a migrated agent reads every current object: the shared inbox holds free text about any of them.
export async function readsEverything(ctx: Ctx, agent: Doc<"agents">) {
  if (agent.authorityVersion !== 1) return false;
  if (agent.readAllObjects) return true;
  return (await ctx.db.query("objects").withIndex("by_org", (q) => q.eq("orgId", agent.orgId)).collect()).every((o) => agent.readObjectIds?.includes(o._id));
}

export function granted(agent: Doc<"agents">, action: "create" | "update" | "delete", object: Doc<"objects">, org: Doc<"orgs">) {
  if (agent.authorityVersion === 1) return agent.grants.some(grant => grant.action === action && grant.objectId === object._id);
  return org.authorityFrozenAt !== undefined && object._creationTime <= org.authorityFrozenAt && agent.grants.some(grant => grant.action === action && (grant.objectKey === "*" || grant.objectKey === frozenKey(org, object)));
}

export function roleOf(principal: Principal): Role { return "member" in principal ? principal.member.role : principal.agent.role; }

export async function requireMember(ctx: Ctx, orgId: Id<"orgs">, minRole: Role = "member"): Promise<Membership> {
  const principal = await getPrincipal(ctx);
  const member = await ctx.db.query("members").withIndex("by_org_user", (q) => q.eq("orgId", orgId).eq("userId", principal.user._id)).unique();
  if (!member || rank[member.role] < rank[minRole]) fail("FORBIDDEN", "Membership required");
  const org = await ctx.db.get(orgId);
  if (!org) fail("FORBIDDEN", "Membership required");
  return { ...principal, member, org };
}

// CLI paths (`convex run`) have no signed-in identity, so the user is named explicitly.
export async function memberAs(ctx: Ctx, orgId: Id<"orgs">, userId: Id<"users">, minRole: Role): Promise<Membership> {
  const user = await ctx.db.get(userId), org = await ctx.db.get(orgId);
  const member = await ctx.db.query("members").withIndex("by_org_user", (q) => q.eq("orgId", orgId).eq("userId", userId)).unique();
  if (!user || !org || !member || rank[member.role] < rank[minRole]) fail("FORBIDDEN", `${minRole[0]!.toUpperCase()}${minRole.slice(1)} membership required`);
  return { user, member, org, actor: { kind: "user", id: user._id } };
}

// Internal domain helpers receive server-derived principals, then re-read their
// membership/epoch at the write boundary rather than trusting an earlier snapshot.
export async function currentPrincipal(ctx: Ctx, principal: Principal): Promise<Principal> {
  const org = await ctx.db.get(principal.org._id);
  if (!org) fail("FORBIDDEN", "Workspace no longer exists");
  if ("agent" in principal) {
    const agent = await ctx.db.get(principal.agent._id);
    if (!agent || agent.orgId !== org._id || principal.actor.kind !== "agent" || principal.actor.id !== agent._id || agent.revokedAt !== undefined || (agent.state !== undefined && agent.state !== "active") || (agent.authorityEpoch ?? 0) !== (principal.agent.authorityEpoch ?? 0)) fail("FORBIDDEN", "Agent authority changed");
    return { agent, org, capabilities: await validGrants(ctx, agent), readsEverything: await readsEverything(ctx, agent), actor: { kind: "agent", id: agent._id } };
  }
  const user = await ctx.db.get(principal.user._id);
  const member = await ctx.db.query("members").withIndex("by_org_user", q => q.eq("orgId", org._id).eq("userId", principal.user._id)).unique();
  if (!user || !member || member._id !== principal.member._id || principal.actor.kind !== "user" || principal.actor.id !== user._id || (member.authorityEpoch ?? 0) !== (principal.member.authorityEpoch ?? 0)) fail("FORBIDDEN", "Membership changed");
  return { user, member, org, actor: { kind: "user", id: user._id } };
}

export async function requireWriter(ctx: Ctx, orgId: Id<"orgs">, minRole: Role = "member") {
  const member = await requireMember(ctx, orgId, minRole);
  await writable(ctx, orgId);
  return member;
}

export function recordGranted(principal: Principal, action: "create" | "update" | "delete", object: Doc<"objects">, recordId?: Id<"records">, fieldIds: string[] = []) {
  if ("member" in principal) return true;
  return granted(principal.agent, action, object, principal.org) || fieldGranted(principal, action, object, recordId, fieldIds);
}
// New-style direct grants only: every touched field must be in one grant's scope.
export function fieldGranted(principal: AgentMembership, action: "create" | "update" | "delete", object: Doc<"objects">, recordId?: Id<"records">, fieldIds: string[] = []) {
  return principal.capabilities?.some(g => g.mode === "direct" && g.capability === `record.${action}` && g.scope.kind === "records" && g.scope.objectId === object._id && (g.scope.records === "all" || (recordId !== undefined && g.scope.records.includes(recordId))) && fieldIds.every(id => g.scope.kind === "records" && g.scope.fields.includes(id as Id<"fields">))) ?? false;
}

// Operator tools (`convex run`) have no signed-in user; they act for the workspace owner.
export async function ownerOf(ctx: Ctx, orgId: Id<"orgs">): Promise<Membership> {
  const org = await ctx.db.get(orgId);
  const member = (await ctx.db.query("members").withIndex("by_org_user", (q) => q.eq("orgId", orgId)).collect()).find((m) => m.role === "owner");
  const user = member && await ctx.db.get(member.userId);
  if (!org || !member || !user) fail("NOT_FOUND", "Workspace or its owner not found");
  return { user, member, org, actor: { kind: "user", id: user._id } };
}
