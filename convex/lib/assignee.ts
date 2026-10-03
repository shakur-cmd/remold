import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
type Reader = Pick<QueryCtx, "db">;
import { fail } from "../errors";
import type { Principal } from "../identity";

// A task's assignee is stored as plain text: a member's user id or an active agent's id.
export type Assignee = { id: string; name: string; kind: "person" | "agent" };

export async function assigneeOf(ctx: Reader, orgId: Id<"orgs">, value: unknown): Promise<Assignee | null> {
  if (typeof value !== "string") return null;
  const userId = ctx.db.normalizeId("users", value);
  if (userId) {
    const [user, member] = await Promise.all([ctx.db.get(userId), ctx.db.query("members").withIndex("by_org_user", (q) => q.eq("orgId", orgId).eq("userId", userId)).unique()]);
    return user && member ? { id: userId, name: user.name ?? user.email ?? "Member", kind: "person" } : null;
  }
  const agentId = ctx.db.normalizeId("agents", value), agent = agentId ? await ctx.db.get(agentId) : null;
  return agent && agent.orgId === orgId && live(agent) ? { id: agent._id, name: agent.name, kind: "agent" } : null;
}
const live = (agent: { state?: string; revokedAt?: number }) => agent.revokedAt === undefined && (agent.state ?? "active") === "active";

// Everyone a task can be given to: the workspace's members and its active agents.
export async function assignees(ctx: Reader, orgId: Id<"orgs">): Promise<Assignee[]> {
  const members = await ctx.db.query("members").withIndex("by_org_user", (q) => q.eq("orgId", orgId)).collect();
  const people = (await Promise.all(members.map(async (m) => { const user = await ctx.db.get(m.userId); return user ? [{ id: user._id as string, name: user.name ?? user.email ?? "Member", kind: "person" as const }] : []; }))).flat();
  const agents = (await ctx.db.query("agents").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()).filter(live).map((a) => ({ id: a._id as string, name: a.name, kind: "agent" as const }));
  return [...people, ...agents];
}

// The id a written assignee names: an id, or a name that is the same as exactly one person or agent.
// An agent may take a task, leave it, or hand it to a person, but not give it to another agent.
export async function resolveAssignee(ctx: Reader, principal: Principal, input: unknown, fieldKey: string): Promise<string> {
  if (typeof input !== "string" || !input.trim()) fail("VALIDATION", "Expected a person or agent", { fieldKey });
  const text = input.trim(), all = await assignees(ctx, principal.org._id);
  const named = all.filter((a) => a.id === text || a.name.toLowerCase() === text.toLowerCase());
  const exact = named.filter((a) => a.id === text);
  const found = exact.length ? exact : named;
  if (found.length === 0) fail("VALIDATION", "Not a person or agent in this workspace", { fieldKey });
  if (found.length > 1) fail("VALIDATION", `More than one match for "${text}"; use the id`, { fieldKey });
  if ("agent" in principal && found[0]!.kind === "agent" && found[0]!.id !== principal.agent._id) fail("FORBIDDEN", "An agent can give a task to a person, not to another agent", { fieldKey });
  return found[0]!.id;
}
