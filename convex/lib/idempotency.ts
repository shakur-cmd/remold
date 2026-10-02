import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { fail } from "../errors";

// ADR 002 request replay. A key belongs to one agent key, is bound to a hash of the
// route and body, and is kept for WINDOW_MS. The lookup and the write that remembers
// it share the caller's transaction, so concurrent duplicates conflict and the retry
// replays; a failed request rolls back and leaves the key unused.
export const WINDOW_MS = 24 * 60 * 60_000;
export const idempotency = v.optional(v.object({ key: v.string(), hash: v.string() }));
export type Idempotency = { key: string; hash: string };

const stored = (ctx: MutationCtx, agentId: Id<"agents">, key: string) => ctx.db.query("idempotencyKeys").withIndex("by_agent_key", (q) => q.eq("agentId", agentId).eq("key", key)).unique();

export async function replay(ctx: MutationCtx, agentId: Id<"agents">, request?: Idempotency): Promise<{ result: any } | null> {
  if (!request) return null;
  const found = await stored(ctx, agentId, request.key);
  if (!found || found.expiresAt <= Date.now()) return null;
  if (found.requestHash !== request.hash) fail("IDEMPOTENCY_MISMATCH", "This Idempotency-Key was already used with a different request");
  return { result: found.result };
}

export async function remember<T>(ctx: MutationCtx, orgId: Id<"orgs">, agentId: Id<"agents">, request: Idempotency | undefined, result: T): Promise<T> {
  if (!request) return result;
  const now = Date.now(), found = await stored(ctx, agentId, request.key), row = { orgId, agentId, key: request.key, requestHash: request.hash, result, expiresAt: now + WINDOW_MS };
  if (found) await ctx.db.replace(found._id, row); else await ctx.db.insert("idempotencyKeys", row);
  // Later writes sweep a few expired keys each, so no cron is needed.
  for (const old of await ctx.db.query("idempotencyKeys").withIndex("by_expiry", (q) => q.lt("expiresAt", now)).take(10)) await ctx.db.delete(old._id);
  return result;
}
