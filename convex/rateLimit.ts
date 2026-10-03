import { internalMutation } from "./_generated/server";
import { components } from "./_generated/api";
import { v } from "convex/values";
import { RateLimiter, MINUTE, HOUR } from "@convex-dev/rate-limiter";
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

// Website lead intake. The daily workspace cap is passed inline because it comes from the environment.
export const intakeLimiter = new RateLimiter(components.rateLimiter, {
  intakeKey: { kind: "token bucket", rate: 10, period: MINUTE, capacity: 10 },
  intakeEmail: { kind: "fixed window", rate: 3, period: HOUR },
  intakeAlert: { kind: "fixed window", rate: 1, period: HOUR },
});

// Public booking pages: per page and per address. The workspace's daily cap is passed inline (environment).
export const bookingLimiter = new RateLimiter(components.rateLimiter, {
  bookingPage: { kind: "token bucket", rate: 20, period: MINUTE, capacity: 20 },
  bookingEmail: { kind: "fixed window", rate: 3, period: HOUR },
});
