import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { agentWriteLimiter } from "./rateLimit";

// This file is copied only into an anonymous scratch deployment by rate-limit.mjs.
export const seed = internalMutation({
  args: { keyHashes: v.array(v.string()) },
  handler: async (ctx, { keyHashes }) => {
    const userId = await ctx.db.insert("users", { tokenIdentifier: "proof-only", name: "Synthetic operator" });
    const orgs = [];
    for (const label of ["A", "B"]) orgs.push(await ctx.db.insert("orgs", { name: `Rate fixture ${label}`, createdBy: userId }));
    const agents = [];
    for (let i = 0; i < keyHashes.length; i++) agents.push(await ctx.db.insert("agents", { orgId: orgs[i < 2 ? 0 : 1], name: `fixture-${i}`, role: "member", createdBy: userId, keyHash: keyHashes[i], keyPrefix: "synthetic", grants: [] }));
    await agentWriteLimiter.limit(ctx, "agentWrite", { key: agents[0], count: 110 });
    await ctx.db.insert("members", { orgId: orgs[0], userId, role: "owner" });
    const userB = await ctx.db.insert("users", { tokenIdentifier: "proof-b", name: "Synthetic B" });
    await ctx.db.insert("members", { orgId: orgs[1], userId: userB, role: "owner" });
    return { orgA: orgs[0], orgB: orgs[1], startedAt: Date.now() };
  },
});
export const snapshot = internalQuery({ args: {}, handler: async (ctx) => ({
  inbox: (await ctx.db.query("agentInbox").collect()).map(({ orgId, text }) => ({ orgId, text })),
  events: (await ctx.db.query("events").collect()).length,
  opsEvents: await ctx.db.query("opsEvents").collect(),
}) });
