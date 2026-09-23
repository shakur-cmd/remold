import { query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { requireMember } from "./identity";
import { fail } from "./errors";

export const forRecord = query({ args: { orgId: v.id("orgs"), recordId: v.id("records") }, handler: async (ctx, args) => {
  await requireMember(ctx, args.orgId);
  const record = await ctx.db.get(args.recordId);
  if (!record || record.orgId !== args.orgId) fail("NOT_FOUND", "Record not found");
  const events = await ctx.db.query("events").withIndex("by_record", (q) => q.eq("orgId", args.orgId).eq("recordId", args.recordId)).order("desc").take(200);
  return Promise.all(events.map(async (event) => {
    const actor = event.actor.kind === "user" ? await ctx.db.get(event.actor.id as Id<"users">) : event.actor.kind === "agent" ? await ctx.db.get(event.actor.id as Id<"agents">) : null;
    const suggestion = event.suggestionId ? await ctx.db.get(event.suggestionId) : null;
    const appliedBy = suggestion?.resolvedBy ? await ctx.db.get(suggestion.resolvedBy) : null;
    return { ...event, actorName: actor?.name ?? null, appliedByName: appliedBy?.name ?? null };
  }));
} });
export const forOrg = query({ args: { orgId: v.id("orgs"), paginationOpts: paginationOptsValidator }, handler: async (ctx, args) => { await requireMember(ctx, args.orgId); return ctx.db.query("events").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).order("desc").paginate(args.paginationOpts); } });
