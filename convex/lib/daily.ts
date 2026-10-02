import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { Principal } from "../identity";
import { v } from "convex/values";
import { fail } from "../errors";
import { canReadObject, canReadField, canReadRecord, canQueryField, firstVisible, listedRecords } from "../authority/reads";
import { allDay } from "./values";

const slotOf = (field: Doc<"fields">) => `${field.slot!.kind}${field.slot!.index}`;

// A run of the viewer's local days, firstDay..lastDay as UTC midnights. All-day
// values (whole UTC midnights) match by that calendar date; instants match from
// the local midnight `start` through `end`, the next local midnight minus 1 ms,
// which the viewer computes so that DST days are 23 or 25 hours long.
export const localDays = { firstDay: v.number(), lastDay: v.number(), start: v.number(), end: v.number() };
export type LocalDays = { firstDay: number; lastDay: number; start: number; end: number };
type Interval = { lo: number; hi: number; loOpen: boolean; hiOpen: boolean };
const DAY = 86400000, MAX_DAYS = 62;

// The exact index intervals for those days, ascending and disjoint: each all-day
// date as a point, and the instants between the whole UTC midnights inside
// [start, end] (an instant is never a whole midnight). No off-day row is in them.
export function dayIntervals(w: LocalDays): Interval[] {
  const days = (w.lastDay - w.firstDay) / DAY;
  if (!allDay(w.firstDay) || !allDay(w.lastDay) || days < 0 || days >= MAX_DAYS || !(w.start <= w.end) || w.end - w.start > (days + 2) * DAY) fail("VALIDATION", "Invalid day range");
  const out: Interval[] = [];
  for (let d = w.firstDay; d <= w.lastDay; d += DAY) out.push({ lo: d, hi: d, loOpen: false, hiOpen: false });
  const cuts: number[] = [];
  for (let m = Math.ceil(w.start / DAY) * DAY; m <= w.end; m += DAY) cuts.push(m);
  const bounds = [w.start, ...cuts, w.end];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const lo = bounds[i]!, hi = bounds[i + 1]!, loOpen = cuts.includes(lo), hiOpen = cuts.includes(hi);
    if (lo < hi || (lo === hi && !loOpen && !hiOpen)) out.push({ lo, hi, loOpen, hiOpen });
  }
  return out.sort((a, b) => a.lo - b.lo || Number(a.loOpen) - Number(b.loOpen));
}
const inside = (iv: Interval, x: number) => (iv.loOpen ? x > iv.lo : x >= iv.lo) && (iv.hiOpen ? x < iv.hi : x <= iv.hi);

// A row's place in the index: date value, then creation time. Cursors are
// "range:<value>:<creation time>", or "range:start" for a page that has read
// nothing yet, which the client keeps open rather than pinning.
type Position = { v: number; t: number };
const START = "range:start";
const encode = (p: Position) => `range:${p.v}:${p.t}`;
function decode(cursor: string | null | undefined): Position | undefined {
  if (!cursor || cursor === START) return undefined;
  const m = /^range:(-?\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(cursor);
  return m ? { v: Number(m[1]), t: Number(m[2]) } : fail("VALIDATION", "Invalid cursor");
}
const beyond = (a: Position, b: Position) => a.v > b.v || (a.v === b.v && a.t > b.t);
// Rows read per page. A page pinned to an endCursor returns everything up to it however
// many rows that is, so it may grow with writes; past PINNED_CAP it fails rather than drop rows.
export const READ_BUDGET = 1000, PINNED_CAP = 4 * READ_BUDGET;
export type PageOpts = { cursor: string | null; numItems: number; endCursor?: string | null };

// Records whose `date` lies in `intervals` and that `keep` accepts, earliest
// first, paged like Convex's paginate. A record-scoped caller is served from their
// list, keeping only records whose date and `gates` fields they can read before
// looking at those values. Anyone else must be able to read and query them on
// every record, and is served from the index. Without an endCursor a page stops
// after numItems kept rows or READ_BUDGET rows read, whichever comes first, and
// isDone is true only when nothing in the intervals is left unread. With an
// endCursor (a page the client has pinned) it returns every row from its cursor
// to that end, so writes grow or shrink the page instead of shifting rows across
// a boundary, and isDone says whether anything kept follows the end.
export async function datedRecords(ctx: QueryCtx, principal: Principal, object: Doc<"objects">, date: Doc<"fields"> | undefined, gates: Doc<"fields">[], keep: (row: Doc<"records">) => boolean, intervals: Interval[], opts: PageOpts): Promise<{ page: Doc<"records">[]; isDone: boolean; continueCursor: string }> {
  const after = decode(opts.cursor), until = decode(opts.endCursor), n = Math.max(1, Math.floor(opts.numItems));
  const none = { page: [], isDone: true, continueCursor: opts.endCursor ?? opts.cursor ?? START };
  if (!canReadObject(principal, object) || !date?.slot || ![date, ...gates].every(f => canReadField(principal, object, f))) return none;
  const slot = slotOf(date), at = (row: Doc<"records">) => (row as Record<string, unknown>)[slot] as number, pos = (row: Doc<"records">): Position => ({ v: at(row), t: row._creationTime });
  const listed = await listedRecords(ctx, principal, object);
  let rows: AsyncIterable<Doc<"records">> | Doc<"records">[];
  if (listed) rows = listed.filter(row => [date, ...gates].every(f => canReadField(principal, object, f, row._id))).filter(row => typeof at(row) === "number" && intervals.some(iv => inside(iv, at(row))) && (!after || beyond(pos(row), after))).sort((a, b) => at(a) - at(b) || a._creationTime - b._creationTime);
  else if (![date, ...gates].every(f => canQueryField(principal, object, f))) return none;
  else rows = scan(ctx, object, slot, intervals, after);
  const kept = (row: Doc<"records">) => keep(row) && (!!listed || canReadRecord(principal, object, row));
  const page: Doc<"records">[] = [];
  let reads = 0, last = after;
  if (until) {
    let past = 0;
    for await (const row of rows) {
      if (!beyond(pos(row), until)) {
        if (++reads > PINNED_CAP) fail("CONFLICT", "Too many records were added to this range while it was open; reload it");
        if (kept(row)) page.push(row);
      } else if (kept(row)) return { page, isDone: false, continueCursor: opts.endCursor! };
      else if (++past >= READ_BUDGET) return { page, isDone: false, continueCursor: opts.endCursor! };
    }
    return { page, isDone: true, continueCursor: opts.endCursor! };
  }
  for await (const row of rows) {
    reads++; last = pos(row);
    if (kept(row)) page.push(row);
    if (page.length >= n || (!listed && reads >= READ_BUDGET)) return { page, isDone: false, continueCursor: encode(last) };
  }
  return { page, isDone: true, continueCursor: last ? encode(last) : START };
}

// The index rows in `intervals` strictly after `from`, in index order.
async function* scan(ctx: QueryCtx, object: Doc<"objects">, slot: string, intervals: Interval[], from: Position | undefined): AsyncGenerator<Doc<"records">> {
  const index = (range: (q: any) => any) => (ctx.db.query("records") as any).withIndex(`by_${slot}`, (q: any) => range(q.eq("orgId", object.orgId).eq("objectId", object._id))) as AsyncIterable<Doc<"records">>;
  const upTo = (iv: Interval) => (q: any) => (iv.hiOpen ? q.lt(slot, iv.hi) : q.lte(slot, iv.hi));
  for (const iv of intervals) {
    if (!from || iv.lo > from.v || (iv.lo === from.v && iv.loOpen)) yield* index(q => upTo(iv)(iv.loOpen ? q.gt(slot, iv.lo) : q.gte(slot, iv.lo)));
    else if (inside(iv, from.v)) {
      yield* index(q => q.eq(slot, from.v).gt("_creationTime", from.t));
      if (from.v < iv.hi) yield* index(q => upTo(iv)(q.gt(slot, from.v)));
    }
    // Otherwise the whole interval lies before the cursor.
  }
}

// Open tasks due before `until`, earliest first. Dates are integers, so from 1 is "after 0".
export const dueTasks = async (ctx: QueryCtx, principal: Principal, task: Doc<"objects">, due: Doc<"fields"> | undefined, done: Doc<"fields"> | undefined, until: number, limit: number) =>
  (await datedRecords(ctx, principal, task, due, done ? [done] : [], row => !done || row.values[done._id] !== true, [{ lo: 1, hi: until, loOpen: false, hiOpen: true }], { cursor: null, numItems: limit })).page;

// Opportunities untouched since `before` that are not won or lost, longest untouched first.
export async function quietDeals(ctx: QueryCtx, principal: Principal, deal: Doc<"objects">, stage: Doc<"fields"> | undefined, before: number, limit: number): Promise<Doc<"records">[]> {
  if (!canReadObject(principal, deal) || (stage && !canReadField(principal, deal, stage))) return [];
  const open = (row: Doc<"records">) => { const value = stage ? row.values[stage._id] : undefined; return value !== "won" && value !== "lost"; };
  const listed = await listedRecords(ctx, principal, deal);
  if (listed) return listed.filter(row => !stage || canReadField(principal, deal, stage, row._id)).filter(row => row.updatedAt < before && open(row)).sort((a, b) => a.updatedAt - b.updatedAt || a._creationTime - b._creationTime).slice(0, limit);
  if (stage && !canQueryField(principal, deal, stage)) return [];
  return firstVisible(ctx.db.query("records").withIndex("by_object_updated", (q) => q.eq("orgId", deal.orgId).eq("objectId", deal._id).lt("updatedAt", before)), limit, row => open(row) && canReadRecord(principal, deal, row) ? row : null);
}
