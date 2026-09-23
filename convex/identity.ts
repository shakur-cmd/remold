import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import { fail } from "./errors";

export type Role = "owner" | "admin" | "member";
export type Actor = { kind: "user" | "agent" | "automation"; id: string };
export type UserPrincipal = { user: Doc<"users">; actor: { kind: "user"; id: string } };
export type Membership = UserPrincipal & { member: Doc<"members">; org: Doc<"orgs"> };
export type AgentMembership = { agent: Doc<"agents">; org: Doc<"orgs">; actor: { kind: "agent"; id: string } };
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
  if (!agent || agent.revokedAt) fail("UNAUTHENTICATED", "Invalid or revoked agent key");
  const org = await ctx.db.get(agent.orgId);
  if (!org) fail("UNAUTHENTICATED", "Invalid or revoked agent key");
  return { agent, org, actor: { kind: "agent", id: agent._id } };
}

export function granted(agent: Doc<"agents">, action: "create" | "update" | "delete", objectKey: string) {
  return agent.grants.some((grant) => grant.action === action && (grant.objectKey === "*" || grant.objectKey === objectKey));
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
