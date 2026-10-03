import { query } from "./_generated/server";
import { v } from "convex/values";
import { requireMember } from "./identity";
import { assignees as everyone, assigneeNeedsSlot } from "./lib/assignee";

// Who a task can be given to: the workspace's members and its active agents.
export const assignees = query({ args: { orgId: v.id("orgs") }, handler: async (ctx, args) => { await requireMember(ctx, args.orgId); return everyone(ctx, args.orgId); } });

// Whether the workspace's Task assignee has no slot, so the queue falls back to a bounded scan.
export const status = query({ args: { orgId: v.id("orgs") }, handler: async (ctx, args) => { await requireMember(ctx, args.orgId); return { assigneeNeedsSlot: await assigneeNeedsSlot(ctx, args.orgId) }; } });
