import { query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { requireMember, type Principal } from "./identity";
import { fail } from "./errors";
import { canReadObject, canReadRecord, canQueryField, projectEvent, projectRecord, listedRecordIds, paginateIndex } from "./authority/reads";
import { listedRelated } from "./lib/list";
import { bounded, fetch, listStream, mergePage, type Stream } from "./lib/merge";
import { allDay } from "./lib/values";

async function describe(ctx: QueryCtx, principal: Principal, event: Doc<"events">) {
  const actor = event.actor.kind === "user" ? await ctx.db.get(event.actor.id as Id<"users">) : event.actor.kind === "agent" ? await ctx.db.get(event.actor.id as Id<"agents">) : null;
  const suggestion = event.suggestionId ? await ctx.db.get(event.suggestionId) : null;
  const appliedBy = suggestion?.resolvedBy ? await ctx.db.get(suggestion.resolvedBy) : null;
  const masked = await projectEvent(ctx, principal, event);
  return masked ? { ...masked, actorName: actor?.name ?? null, appliedByName: appliedBy?.name ?? null } : null;
}
// An unreadable record gets the same answer as a deleted one.
async function readableRecord(ctx: QueryCtx, principal: Principal, orgId: Id<"orgs">, recordId: Id<"records">) {
  const record = await ctx.db.get(recordId);
  const object = record && record.orgId === orgId ? await ctx.db.get(record.objectId) : null;
  if (!record || !object || !canReadRecord(principal, object, record)) fail("NOT_FOUND", "Record not found");
  return record;
}

export const forRecord = query({ args: { orgId: v.id("orgs"), recordId: v.id("records") }, handler: async (ctx, args) => {
  const principal = await requireMember(ctx, args.orgId);
  await readableRecord(ctx, principal, args.orgId, args.recordId);
  const events = await ctx.db.query("events").withIndex("by_record", (q) => q.eq("orgId", args.orgId).eq("recordId", args.recordId)).order("desc").take(200);
  return (await Promise.all(events.map(event => describe(ctx, principal, event)))).filter((event): event is NonNullable<typeof event> => event !== null);
} });

type Kind = "activity" | "note" | "task";
type Row = { _id: string; at: number; createdAt: number } & ({ event: Doc<"events"> } | { record: Doc<"records">; kind: Kind; byKey: Map<string, Doc<"fields">> });
const slotName = (field: Doc<"fields">) => `${field.slot!.kind}${field.slot!.index}`;
const EARLIEST = -8.64e15;

// One record's history, merged with the activities, notes and tasks whose About
// points at it, newest first, paged by one cursor. Activities sort by "when"
// (by creation when it is empty or not queryable by the caller); everything else
// sorts by when it was written.
export const timeline = query({ args: { orgId: v.id("orgs"), recordId: v.id("records"), paginationOpts: paginationOptsValidator }, handler: async (ctx, args) => {
  const principal = await requireMember(ctx, args.orgId);
  const target = await readableRecord(ctx, principal, args.orgId, args.recordId);
  const streams: Stream<Row>[] = [async (after, until, take) => (await fetch(ctx.db.query("events").withIndex("by_record", (q) => bounded(q.eq("orgId", args.orgId).eq("recordId", target._id), "_creationTime", after, until)).order("desc"), take)).map(event => ({ _id: event._id, at: event._creationTime, createdAt: event._creationTime, event }))];
  for (const kind of ["activity", "note", "task"] as const) {
    const object = await ctx.db.query("objects").withIndex("by_org_key", (q) => q.eq("orgId", args.orgId).eq("key", kind)).unique();
    if (!object || !canReadObject(principal, object)) continue;
    const byKey = new Map((await ctx.db.query("fields").withIndex("by_object", (q) => q.eq("orgId", args.orgId).eq("objectId", object._id)).collect()).filter((f) => !f.retired).map((f) => [f.key, f]));
    const about = byKey.get("about"), when = kind === "activity" ? byKey.get("when") : undefined;
    if (!about || about.type !== "lookup" || about.targetObjectId || !about.slot || !canQueryField(principal, object, about)) continue;
    const byWhen = !!when && when.type === "date" && !!when.slot && canQueryField(principal, object, when);
    const wrap = (record: Doc<"records">): Row => { const value = byWhen ? record.values[when!._id] : undefined; return { _id: record._id, at: typeof value === "number" ? value : record._creationTime, createdAt: record._creationTime, record, kind, byKey }; };
    const listed = await listedRelated(ctx, principal, object, about, target._id);
    if (listed) { streams.push(listStream(listed.map(wrap))); continue; }
    const name = slotName(about), related = () => (ctx.db.query("records") as any).withIndex(`by_${name}`, (q: any) => q.eq("orgId", args.orgId).eq("objectId", object._id).eq(name, target._id));
    const byCreation = (filter?: (q: any) => any): Stream<Row> => async (after, until, take) => {
      let rows = (ctx.db.query("records") as any).withIndex(`by_${name}`, (q: any) => bounded(q.eq("orgId", args.orgId).eq("objectId", object._id).eq(name, target._id), "_creationTime", after, until));
      if (filter) rows = rows.filter(filter);
      return ((await fetch(rows.order("desc"), take)) as Doc<"records">[]).map(wrap);
    };
    if (!byWhen) streams.push(byCreation());
    else if (name === "s2" && slotName(when!) === "d0") {
      // The standard Activity's slots: dated rows come off the about+when index, undated ones by creation.
      const dated = (q: any) => q.eq("orgId", args.orgId).eq("objectId", object._id).eq("s2", target._id);
      streams.push(async (after, until, take) => {
        // Rows sharing the cursor's "when" continue by creation; the rest come strictly older.
        const ties = after ? await fetch(ctx.db.query("records").withIndex("by_s2_d0", (q) => dated(q).eq("d0", after.at).lte("_creationTime", after.createdAt)).order("desc"), take) : [];
        const older = await fetch(ctx.db.query("records").withIndex("by_s2_d0", (q) => { const b = dated(q).gte("d0", until?.at ?? EARLIEST); return after ? b.lt("d0", after.at) : b; }).order("desc"), take);
        return [...ties, ...older].map(wrap);
      });
      streams.push(byCreation((q: any) => q.eq(q.field("d0"), undefined)));
    } else streams.push(listStream(((await related().collect()) as Doc<"records">[]).map(wrap)));
  }
  const page = await mergePage("timeline", streams, args.paginationOpts);
  const entries = await Promise.all(page.page.map(async (row) => {
    if ("event" in row) { const event = await describe(ctx, principal, row.event); return event && { kind: "event" as const, at: row.at, ...event }; }
    const record = await projectRecord(ctx, principal, row.record); if (!record) return null;
    const value = (key: string) => { const field = row.byKey.get(key); return field ? record.values[field._id] : undefined; };
    const due = value("dueDate"), type = row.byKey.get("type");
    return { kind: row.kind, _id: record._id, at: row.at, objectKey: row.kind, title: record.title, createdAt: record._creationTime,
      ...(row.kind === "activity" ? { type: type && value("type") !== undefined ? type.options?.find((o) => o.id === value("type"))?.label ?? String(value("type")) : null, allDay: typeof value("when") === "number" && row.at === value("when") && allDay(row.at), source: (value("source") as string | undefined) ?? null } : {}),
      ...(row.kind === "task" ? { due: typeof due === "number" ? due : null, dueWithTime: !!row.byKey.get("dueDate")?.withTime, done: value("done") === true } : {}) };
  }));
  return { ...page, page: entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null) };
} });

export const forOrg = query({ args: { orgId: v.id("orgs"), paginationOpts: paginationOptsValidator }, handler: async (ctx, args) => {
  const principal = await requireMember(ctx, args.orgId);
  // Only a caller who covers every record of every object can page the org-wide index
  // without meeting hidden events. Anyone else pages the objects and records they
  // can read, so hidden activity never shortens a page.
  const objects = await ctx.db.query("objects").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).collect();
  const sources: ({ objectId: Id<"objects"> } | { recordId: Id<"records"> })[] = []; let restricted = false;
  for (const object of objects) { const ids = listedRecordIds(principal, object); if (ids === null) sources.push({ objectId: object._id }); else { restricted = true; sources.push(...ids.map(recordId => ({ recordId }))); } }
  const page = restricted ? await mergedEvents(ctx, args.orgId, sources, args.paginationOpts) : await paginateIndex(ctx.db.query("events").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).order("desc"), args.paginationOpts);
  return { ...page, page: (await Promise.all(page.page.map(e => projectEvent(ctx, principal, e)))).filter((event): event is NonNullable<typeof event> => event !== null) };
} });

async function mergedEvents(ctx: QueryCtx, orgId: Id<"orgs">, sources: ({ objectId: Id<"objects"> } | { recordId: Id<"records"> })[], opts: { cursor: string | null; numItems: number; endCursor?: string | null }) {
  const page = await mergePage("events", sources.map(s => async (after, until, take) => (await fetch(("recordId" in s
    ? ctx.db.query("events").withIndex("by_record", (q) => bounded(q.eq("orgId", orgId).eq("recordId", s.recordId), "_creationTime", after, until))
    : ctx.db.query("events").withIndex("by_object", (q) => bounded(q.eq("orgId", orgId).eq("objectId", s.objectId), "_creationTime", after, until))
  ).order("desc"), take)).map(event => ({ _id: event._id as string, at: event._creationTime, createdAt: event._creationTime, event }))), opts);
  return { ...page, page: page.page.map(row => row.event) };
}
