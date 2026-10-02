import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { v } from "convex/values";
import { allDay } from "./values";
import { fail } from "../errors";
import type { Principal } from "../identity";
import { canReadObject, canReadRecord, requireObjectRead, requireQueryField, canQueryField, projectRecord, listedRecords, compareIndexValues, pageList, paginateIndex } from "../authority/reads";

const slotName = (kind: string, index: number) => `${kind}${index}`;
type PageOpts = { cursor: string | null; numItems: number; endCursor?: string | null };
type Sort = { fieldId: Id<"fields">; direction: "asc" | "desc" };
type Bounds = { from?: number; to?: number };
export type Where = { filters?: { fieldId: Id<"fields">; value: unknown }[]; range?: { fieldId: Id<"fields">; days?: Bounds } & Bounds };
export const filter = v.object({ fieldId: v.id("fields"), value: v.any() });
const bounds = { from: v.optional(v.number()), to: v.optional(v.number()) };
// Argument validators for Where: several filters combine with AND; the range is inclusive and needs a date field.
// On a with-time field `days` bounds all-day values (whole UTC midnights) by calendar date,
// while from/to bound instants, so a range can follow the viewer's local days.
export const whereArgs = { filters: v.optional(v.array(filter)), range: v.optional(v.object({ fieldId: v.id("fields"), ...bounds, days: v.optional(v.object(bounds)) })) };
export const MAX_FILTERS = 5;
const TOTALS_CAP = 4000;
const DAY = 86400000;
// Whole UTC midnights in [lo, hi]: the all-day values a range edge can disagree about.
const midnights = (lo: number, hi: number) => { const out: number[] = []; for (let m = Math.ceil(lo / DAY) * DAY; m <= hi; m += DAY) { out.push(m); if (out.length > 3) fail("VALIDATION", "All-day bounds must be within a day of the time bounds"); } return out; };

// Checks every field the query names and picks one index for it: the sort field,
// else the range field, else the first filter. The other conditions are checked on
// the rows that index yields, so any combination returns the same rows in the
// same order on the index path and on a record-scoped reader's own list.
async function plan(ctx: QueryCtx, orgId: Id<"orgs">, object: Doc<"objects">, sort: Sort | undefined, where: Where, principal?: Principal) {
  const filters = where.filters ?? [], range = where.range;
  if (filters.length > MAX_FILTERS) fail("UNSUPPORTED", `At most ${MAX_FILTERS} filters`);
  const slot = async (fieldId: Id<"fields">) => {
    const field = await ctx.db.get(fieldId); if (!field || field.orgId !== orgId || field.objectId !== object._id) fail("NOT_FOUND", "Field not found"); if (!field.slot) fail("UNINDEXED_FIELD", "Field is not indexed");
    if (principal) requireQueryField(principal, object, field);
    return { field, name: slotName(field.slot.kind, field.slot.index) };
  };
  const eqs = await Promise.all(filters.map(async (filter) => ({ name: (await slot(filter.fieldId)).name, value: filter.value ?? undefined })));
  let bounds: { name: string; from?: number; to?: number; days?: Bounds; low?: number; high?: number; outside: number[]; inside: number[] } | undefined;
  if (range) {
    const { field, name } = await slot(range.fieldId), { from, to, days } = range;
    if (field.type !== "date") fail("VALIDATION", "A range needs a date field");
    if (from === undefined && to === undefined) fail("VALIDATION", "A range needs a start or an end");
    if (from !== undefined && to !== undefined && from > to) fail("VALIDATION", "A range must start before it ends");
    if (days && (!field.withTime || (days.from === undefined) !== (from === undefined) || (days.to === undefined) !== (to === undefined) || [days.from, days.to].some((d) => d !== undefined && !allDay(d)) || (days.from! > days.to!))) fail("VALIDATION", "Invalid all-day bounds");
    // Index bounds cover both; `outside` are all-day values inside from..to but not within days, `inside` the reverse.
    const low = days?.from === undefined ? from : Math.min(from!, days.from), high = days?.to === undefined ? to : Math.max(to!, days.to);
    const outside = days ? [...(from !== undefined ? midnights(from, days.from! - 1) : []), ...(to !== undefined ? midnights(days.to! + 1, to) : [])] : [];
    const inside = days ? [...(from !== undefined ? midnights(days.from!, Math.min(from - 1, days.to ?? Infinity)) : []), ...(to !== undefined ? midnights(Math.max(to + 1, days.from ?? -Infinity), days.to!) : [])] : [];
    bounds = { name, from, to, days, low, high, outside, inside };
  }
  const lead = sort ? (await slot(sort.fieldId)).name : bounds?.name ?? eqs[0]?.name;
  const at = (row: Doc<"records">, name: string) => (row as Record<string, unknown>)[name];
  const within = (value: number, b: Bounds) => (b.from === undefined || value >= b.from) && (b.to === undefined || value <= b.to);
  const inRange = (value: unknown) => typeof value === "number" && (bounds!.days && allDay(value) ? within(value, bounds!.days) : within(value, bounds!));
  const match = (row: Doc<"records">) => eqs.every(({ name, value }) => compareIndexValues(at(row, name), value) === 0) && (!bounds || inRange(at(row, bounds.name)));
  const listed = principal ? await listedRecords(ctx, principal, object) : null;
  if (listed) {
    const rows = listed.filter(match);
    if (!lead) return { rows: rows.sort((a, b) => b.updatedAt - a.updatedAt || b._creationTime - a._creationTime) };
    rows.sort((a, b) => compareIndexValues(at(a, lead), at(b, lead)) || a._creationTime - b._creationTime);
    return { rows: sort?.direction === "desc" ? rows.reverse() : rows };
  }
  if (!lead) return { query: ctx.db.query("records").withIndex("by_object_updated", (q) => q.eq("orgId", orgId).eq("objectId", object._id)).order("desc") as any };
  // The lead's own condition narrows the index; the filter re-checks it, which costs nothing.
  const leadEq = eqs.find((eq) => eq.name === lead), leadRange = !leadEq && bounds?.name === lead ? bounds : undefined;
  let query: any = (ctx.db.query("records") as any).withIndex(`by_${lead}`, (q: any) => {
    const base = q.eq("orgId", orgId).eq("objectId", object._id);
    if (leadEq) return base.eq(lead, leadEq.value);
    if (!leadRange) return base;
    const low = leadRange.low === undefined ? base.gt(lead, null) : base.gte(lead, leadRange.low);
    return leadRange.high === undefined ? low : low.lte(lead, leadRange.high);
  }).order(sort?.direction ?? "asc");
  if (eqs.length || bounds) query = query.filter((q: any) => q.and(
    ...eqs.map(({ name, value }) => q.eq(q.field(name), value)),
    ...(bounds ? [((b) => { const value = q.field(b.name);
      const timed = q.and(b.from === undefined ? q.gt(value, null) : q.gte(value, b.from), ...(b.to === undefined ? [] : [q.lte(value, b.to)]), ...b.outside.map((m) => q.neq(value, m)));
      return q.or(timed, ...b.inside.map((m) => q.eq(value, m)));
    })(bounds)] : []),
  ));
  return { query };
}

async function objectOf(ctx: QueryCtx, orgId: Id<"orgs">, objectId: Id<"objects">, principal?: Principal) {
  const object = await ctx.db.get(objectId); if (!object || object.orgId !== orgId) fail("NOT_FOUND", "Object not found");
  if (principal) requireObjectRead(principal, object);
  return object;
}

// One page of an object's records, unmasked. A record-scoped caller is served from
// their own record list in the index's order, so hidden rows never shorten a page.
export async function pageRecords(ctx: QueryCtx, orgId: Id<"orgs">, objectId: Id<"objects">, paginationOpts: PageOpts, sort?: Sort, where: Where = {}, principal?: Principal): Promise<{ page: Doc<"records">[]; isDone: boolean; continueCursor: string }> {
  const found = await plan(ctx, orgId, await objectOf(ctx, orgId, objectId, principal), sort, where, principal);
  return found.rows ? pageList(found.rows, paginationOpts) : paginateIndex(found.query, paginationOpts);
}

export async function listRecords(ctx: QueryCtx, orgId: Id<"orgs">, objectId: Id<"objects">, paginationOpts: PageOpts, sort?: Sort, where: Where = {}, principal?: Principal) {
  const page: any = await pageRecords(ctx, orgId, objectId, paginationOpts, sort, where, principal);
  return principal ? { ...page, page: (await Promise.all(page.page.map((record: Doc<"records">) => projectRecord(ctx, principal, record)))).filter(Boolean) } : page;
}

// Count and summed number per value of `group`, over the same rows the list returns
// for `where`. The sum is null when the caller cannot query the number field, rather
// than a total over only the records where they happen to see it. Partial past the cap.
export async function totals(ctx: QueryCtx, principal: Principal, orgId: Id<"orgs">, objectId: Id<"objects">, groupId: Id<"fields">, sumId: Id<"fields"> | undefined, where: Where) {
  const object = await objectOf(ctx, orgId, objectId, principal);
  const field = async (id: Id<"fields">) => { const found = await ctx.db.get(id); if (!found || found.orgId !== orgId || found.objectId !== objectId) fail("NOT_FOUND", "Field not found"); return found; };
  const group = await field(groupId); requireQueryField(principal, object, group);
  const sum = sumId ? await field(sumId) : undefined, summed = sum?.type === "number" && canQueryField(principal, object, sum) ? sum : undefined;
  const found = await plan(ctx, orgId, object, undefined, where, principal);
  const rows: Doc<"records">[] = found.rows ?? await found.query.take(TOTALS_CAP + 1);
  const out = new Map<string | null, { count: number; sum: number }>([...(group.options ?? []).map((option) => [option.id, { count: 0, sum: 0 }] as const), [null, { count: 0, sum: 0 }]]);
  for (const row of rows.slice(0, TOTALS_CAP)) {
    const raw = row.values[group._id], key = raw == null ? null : String(raw), entry = out.get(key) ?? { count: 0, sum: 0 };
    const amount = summed ? row.values[summed._id] : undefined;
    entry.count += 1; if (typeof amount === "number") entry.sum += amount;
    out.set(key, entry);
  }
  return { groups: [...out].map(([value, entry]) => ({ value, count: entry.count, sum: summed ? entry.sum : null })), partial: rows.length > TOTALS_CAP, cap: TOTALS_CAP };
}

const STEPS_CAP = 1000;
// A record's steps: tasks whose About points at it, earliest due first, undated last,
// ties by creation. All of them are ordered before a page is cut, so a step created
// late but due soon is on the first page. A caller who cannot query the due field gets
// creation order, since ordering by a hidden value would reveal it.
export async function steps(ctx: QueryCtx, principal: Principal, orgId: Id<"orgs">, recordId: Id<"records">, paginationOpts: PageOpts) {
  const target = await ctx.db.get(recordId), targetObject = target && target.orgId === orgId ? await ctx.db.get(target.objectId) : null;
  if (!target || !targetObject || !canReadRecord(principal, targetObject, target)) fail("NOT_FOUND", "Record not found");
  const task = await ctx.db.query("objects").withIndex("by_org_key", (q) => q.eq("orgId", orgId).eq("key", "task")).unique();
  const fields = task && canReadObject(principal, task) ? await ctx.db.query("fields").withIndex("by_object", (q) => q.eq("orgId", orgId).eq("objectId", task._id)).collect() : [];
  const about = fields.find((f) => f.key === "about" && f.type === "lookup" && !f.targetObjectId && !f.retired && f.slot && canQueryField(principal, task!, f));
  if (!task || !about) return { page: [], isDone: true, continueCursor: "list:0" };
  const due = fields.find((f) => f.key === "dueDate" && f.type === "date" && !f.retired && canQueryField(principal, task, f));
  const name = slotName(about.slot!.kind, about.slot!.index);
  const rows: Doc<"records">[] = await listedRelated(ctx, principal, task, about, target._id) ?? await (ctx.db.query("records") as any).withIndex(`by_${name}`, (q: any) => q.eq("orgId", orgId).eq("objectId", task._id).eq(name, target._id)).take(STEPS_CAP);
  const dueOf = (r: Doc<"records">) => { const value = due ? r.values[due._id] : undefined; return typeof value === "number" ? value : Infinity; };
  const page = pageList([...rows].sort((a, b) => (dueOf(a) === dueOf(b) ? 0 : dueOf(a) < dueOf(b) ? -1 : 1) || a._creationTime - b._creationTime), paginationOpts);
  return { ...page, page: (await Promise.all(page.page.map((r) => projectRecord(ctx, principal, r)))).filter((r): r is Doc<"records"> => r !== null) };
}

// Records of `source` that point at `targetId` through a lookup or links field, from a
// record-scoped reader's own list, in the same order as the index path. Null means
// the reader covers every source record, so the index path holds nothing hidden.
export async function listedRelated(ctx: QueryCtx, principal: Principal, source: Doc<"objects">, field: Doc<"fields">, targetId: Id<"records">): Promise<Doc<"records">[] | null> {
  const listed = await listedRecords(ctx, principal, source);
  if (!listed) return null;
  if (field.type === "links") {
    const hits = await Promise.all(listed.map(async record => ({ record, link: (await ctx.db.query("links").withIndex("by_from", (q) => q.eq("orgId", source.orgId).eq("fieldId", field._id).eq("fromRecordId", record._id)).collect()).find(link => link.toRecordId === targetId) })));
    return hits.filter(hit => hit.link).sort((a, b) => a.link!._creationTime - b.link!._creationTime).map(hit => hit.record);
  }
  const name = slotName(field.slot!.kind, field.slot!.index);
  return listed.filter(record => (record as Record<string, unknown>)[name] === targetId).sort((a, b) => a._creationTime - b._creationTime);
}
