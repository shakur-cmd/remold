import { internalMutation } from "./_generated/server";
import { components } from "./_generated/api";
import { v } from "convex/values";
import { RateLimiter, MINUTE } from "@convex-dev/rate-limiter";
import { requireAgent } from "./identity";

export const agentWriteLimiter = new RateLimiter(components.rateLimiter, {
  agentWrite: { kind: "token bucket", rate: 120, period: MINUTE, capacity: 120 },
});

export const take = internalMutation({
  args: { keyHash: v.string() },
  handler: async (ctx, { keyHash }) => {
    const { agent } = await requireAgent(ctx, keyHash);
    const result = await agentWriteLimiter.limit(ctx, "agentWrite", { key: agent._id });
    return { allowed: result.ok, retryAfter: result.ok ? 0 : Math.max(1, Math.ceil(result.retryAfter / 1000)) };
  },
});
