import { query, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { requireMember } from "./identity";
import { fail } from "./errors";
import { canReadRecord, projectEvent, listedRecordIds } from "./authority/reads";

export const forRecord = query({ args: { orgId: v.id("orgs"), recordId: v.id("records") }, handler: async (ctx, args) => {
  const principal = await requireMember(ctx, args.orgId);
  const record = await ctx.db.get(args.recordId);
  // An unreadable record gets the same answer as a deleted one.
  const object = record && record.orgId === args.orgId ? await ctx.db.get(record.objectId) : null;
  if (!record || !object || !canReadRecord(principal, object, record)) fail("NOT_FOUND", "Record not found");
  const events = await ctx.db.query("events").withIndex("by_record", (q) => q.eq("orgId", args.orgId).eq("recordId", args.recordId)).order("desc").take(200);
  return (await Promise.all(events.map(async (event) => {
    const actor = event.actor.kind === "user" ? await ctx.db.get(event.actor.id as Id<"users">) : event.actor.kind === "agent" ? await ctx.db.get(event.actor.id as Id<"agents">) : null;
    const suggestion = event.suggestionId ? await ctx.db.get(event.suggestionId) : null;
    const appliedBy = suggestion?.resolvedBy ? await ctx.db.get(suggestion.resolvedBy) : null;
    const masked = await projectEvent(ctx, principal, event);
    return masked ? { ...masked, actorName: actor?.name ?? null, appliedByName: appliedBy?.name ?? null } : null;
  }))).filter((event): event is NonNullable<typeof event> => event !== null);
} });
export const forOrg = query({ args: { orgId: v.id("orgs"), paginationOpts: paginationOptsValidator }, handler: async (ctx, args) => {
  const principal = await requireMember(ctx, args.orgId);
  // Only a caller who covers every record of every object can page the org-wide index
  // without meeting hidden events. Anyone else pages the objects and records they
  // can read, so hidden activity never shortens a page.
  const objects = await ctx.db.query("objects").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).collect();
  const streams: ({ objectId: Id<"objects"> } | { recordId: Id<"records"> })[] = []; let restricted = false;
  for (const object of objects) { const ids = listedRecordIds(principal, object); if (ids === null) streams.push({ objectId: object._id }); else { restricted = true; streams.push(...ids.map(recordId => ({ recordId }))); } }
  const page = restricted ? await mergedEvents(ctx, args.orgId, streams, args.paginationOpts) : await ctx.db.query("events").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).order("desc").paginate(args.paginationOpts);
  return { ...page, page: (await Promise.all(page.page.map(e => projectEvent(ctx, principal, e)))).filter((event): event is NonNullable<typeof event> => event !== null) };
} });

// Newest-first merge of several event streams. The cursor holds the creation time
// reached and the IDs already returned at exactly that time.
async function mergedEvents(ctx: QueryCtx, orgId: Id<"orgs">, streams: ({ objectId: Id<"objects"> } | { recordId: Id<"records"> })[], opts: { cursor: string | null; numItems: number }) {
  let until: number | undefined, seen: string[] = [];
  if (opts.cursor) { const m = /^events:(\d+(?:\.\d+)?|start):(.*)$/.exec(opts.cursor); if (!m) fail("VALIDATION", "Invalid cursor"); until = m[1] === "start" ? undefined : Number(m[1]); seen = m[2] ? m[2].split(",") : []; }
  const n = Math.max(0, Math.floor(opts.numItems)), take = n + seen.length + 1;
  const rows = (await Promise.all(streams.map(s => ("recordId" in s
    ? ctx.db.query("events").withIndex("by_record", (q) => { const b = q.eq("orgId", orgId).eq("recordId", s.recordId); return until === undefined ? b : b.lte("_creationTime", until); })
    : ctx.db.query("events").withIndex("by_object", (q) => { const b = q.eq("orgId", orgId).eq("objectId", s.objectId); return until === undefined ? b : b.lte("_creationTime", until); })
  ).order("desc").take(take)))).flat().filter(e => !seen.includes(e._id));
  rows.sort((a, b) => b._creationTime - a._creationTime || (a._id < b._id ? 1 : a._id > b._id ? -1 : 0));
  const page = rows.slice(0, n), last = page.at(-1);
  const next = last ? last._creationTime : until, carried = !last || next === until ? seen : [];
  const ids = [...carried, ...page.filter(e => e._creationTime === next).map(e => e._id)];
  return { page, isDone: rows.length <= n, continueCursor: `events:${next ?? "start"}:${ids.join(",")}` };
}
