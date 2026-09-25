import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import { fail } from "./errors";
import { writable } from "./authority/readonly";
import { validGrants } from "./authority/grants";

export type Role = "owner" | "admin" | "member";
export type Actor = { kind: "user" | "agent" | "automation"; id: string };
export type UserPrincipal = { user: Doc<"users">; actor: { kind: "user"; id: string } };
export type Membership = UserPrincipal & { member: Doc<"members">; org: Doc<"orgs"> };
export type AgentMembership = { capabilities?: Doc<"capabilityGrants">[]; agent: Doc<"agents">; org: Doc<"orgs">; actor: { kind: "agent"; id: string } };
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

export async function requireAgent(ctx: Ctx, keyHash: string): Promise<AgentMembership> {
  const agent = await ctx.db.query("agents").withIndex("by_key_hash", (q) => q.eq("keyHash", keyHash)).unique();
  if (!agent || agent.revokedAt !== undefined || (agent.state !== undefined && agent.state !== "active")) fail("UNAUTHENTICATED", "Invalid or revoked agent key");
  const org = await ctx.db.get(agent.orgId);
  if (!org) fail("UNAUTHENTICATED", "Invalid or revoked agent key");
  if (agent.authorityVersion !== 1 && org.authorityFrozenAt === undefined) fail("AUTHORITY_MIGRATING", "Workspace authority migration is pending; retry shortly", { retryable: true });
  return { agent, org, capabilities: await validGrants(ctx, agent), actor: { kind: "agent", id: agent._id } };
}

export function granted(agent: Doc<"agents">, action: "create" | "update" | "delete", object: Doc<"objects">, org: Doc<"orgs">) {
  if (agent.authorityVersion === 1) return agent.grants.some(grant => grant.action === action && grant.objectId === object._id);
  return org.authorityFrozenAt !== undefined && object._creationTime <= org.authorityFrozenAt && agent.grants.some(grant => grant.action === action && (grant.objectKey === "*" || grant.objectKey === object.key));
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

// Internal domain helpers receive server-derived principals, then re-read their
// membership/epoch at the write boundary rather than trusting an earlier snapshot.
export async function currentPrincipal(ctx: Ctx, principal: Principal): Promise<Principal> {
  const org = await ctx.db.get(principal.org._id);
  if (!org) fail("FORBIDDEN", "Workspace no longer exists");
  if ("agent" in principal) {
    const agent = await ctx.db.get(principal.agent._id);
    if (!agent || agent.orgId !== org._id || principal.actor.kind !== "agent" || principal.actor.id !== agent._id || agent.revokedAt !== undefined || (agent.state !== undefined && agent.state !== "active") || (agent.authorityEpoch ?? 0) !== (principal.agent.authorityEpoch ?? 0)) fail("FORBIDDEN", "Agent authority changed");
    return { agent, org, capabilities: await validGrants(ctx, agent), actor: { kind: "agent", id: agent._id } };
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
  if (granted(principal.agent, action, object, principal.org)) return true;
  return principal.capabilities?.some(g => g.mode === "direct" && g.capability === `record.${action}` && g.scope.kind === "records" && g.scope.objectId === object._id && (g.scope.records === "all" || (recordId !== undefined && g.scope.records.includes(recordId))) && fieldIds.every(id => g.scope.kind === "records" && g.scope.fields.includes(id as Id<"fields">))) ?? false;
}
