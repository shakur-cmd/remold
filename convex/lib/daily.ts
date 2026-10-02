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

// Where a page stopped: the index position (date value, creation time) of the last row read.
type Position = { v: number; t: number };
const encode = (p: Position) => JSON.stringify(p);
function decode(cursor: string | undefined): Position | null {
  if (cursor === undefined) return null;
  try { const p = JSON.parse(cursor); if (typeof p?.v === "number" && typeof p?.t === "number") return p; } catch {}
  return fail("VALIDATION", "Invalid cursor");
}
const after = (a: Position, b: Position) => a.v > b.v || (a.v === b.v && a.t > b.t);
export const READ_BUDGET = 1000;

// Records whose `date` lies in `intervals` and that `keep` accepts, earliest
// first, a page at a time. A record-scoped caller is served from their list,
// keeping only records whose date and `gates` fields they can read before looking
// at those values. Anyone else must be able to read and query them on every
// record, and is served from the index, reading at most READ_BUDGET rows per
// call. `done` is true only when nothing in the intervals is left unread;
// otherwise `cursor` continues after the last row read.
export async function datedRecords(ctx: QueryCtx, principal: Principal, object: Doc<"objects">, date: Doc<"fields"> | undefined, gates: Doc<"fields">[], keep: (row: Doc<"records">) => boolean, intervals: Interval[], limit: number, cursor?: string): Promise<{ rows: Doc<"records">[]; done: boolean; cursor: string | null }> {
  const from = decode(cursor), none = { rows: [], done: true, cursor: null };
  if (!canReadObject(principal, object) || !date?.slot || ![date, ...gates].every(f => canReadField(principal, object, f))) return none;
  const slot = slotOf(date), at = (row: Doc<"records">) => (row as Record<string, unknown>)[slot], pos = (row: Doc<"records">): Position => ({ v: at(row) as number, t: row._creationTime });
  const listed = await listedRecords(ctx, principal, object);
  if (listed) {
    const rows = listed.filter(row => [date, ...gates].every(f => canReadField(principal, object, f, row._id))).filter(row => typeof at(row) === "number" && intervals.some(iv => inside(iv, at(row) as number)) && (!from || after(pos(row), from)) && keep(row)).sort((a, b) => (at(a) as number) - (at(b) as number) || a._creationTime - b._creationTime);
    const page = rows.slice(0, limit);
    return rows.length > limit ? { rows: page, done: false, cursor: encode(pos(page.at(-1)!)) } : { rows: page, done: true, cursor: null };
  }
  if (![date, ...gates].every(f => canQueryField(principal, object, f))) return none;
  const index = (range: (q: any) => any) => (ctx.db.query("records") as any).withIndex(`by_${slot}`, (q: any) => range(q.eq("orgId", object.orgId).eq("objectId", object._id)));
  const rows: Doc<"records">[] = [];
  let reads = 0;
  for (const iv of intervals) {
    const queries = [];
    if (!from || iv.lo > from.v || (iv.lo === from.v && iv.loOpen)) queries.push(index(q => { const lo = iv.loOpen ? q.gt(slot, iv.lo) : q.gte(slot, iv.lo); return iv.hiOpen ? lo.lt(slot, iv.hi) : lo.lte(slot, iv.hi); }));
    else if (inside(iv, from.v)) {
      queries.push(index(q => q.eq(slot, from.v).gt("_creationTime", from.t)));
      if (from.v < iv.hi) queries.push(index(q => { const lo = q.gt(slot, from.v); return iv.hiOpen ? lo.lt(slot, iv.hi) : lo.lte(slot, iv.hi); }));
    }
    // Otherwise the whole interval lies before the cursor.
    for (const query of queries) for await (const row of query as AsyncIterable<Doc<"records">>) {
      reads++;
      if (keep(row) && canReadRecord(principal, object, row)) rows.push(row);
      if (rows.length >= limit || reads >= READ_BUDGET) return { rows, done: false, cursor: encode(pos(row)) };
    }
  }
  return { rows, done: true, cursor: null };
}

// Open tasks due before `until`, earliest first. Dates are integers, so from 1 is "after 0".
export const dueTasks = async (ctx: QueryCtx, principal: Principal, task: Doc<"objects">, due: Doc<"fields"> | undefined, done: Doc<"fields"> | undefined, until: number, limit: number) =>
  (await datedRecords(ctx, principal, task, due, done ? [done] : [], row => !done || row.values[done._id] !== true, [{ lo: 1, hi: until, loOpen: false, hiOpen: true }], limit)).rows;

// Opportunities untouched since `before` that are not won or lost, longest untouched first.
export async function quietDeals(ctx: QueryCtx, principal: Principal, deal: Doc<"objects">, stage: Doc<"fields"> | undefined, before: number, limit: number): Promise<Doc<"records">[]> {
  if (!canReadObject(principal, deal) || (stage && !canReadField(principal, deal, stage))) return [];
  const open = (row: Doc<"records">) => { const value = stage ? row.values[stage._id] : undefined; return value !== "won" && value !== "lost"; };
  const listed = await listedRecords(ctx, principal, deal);
  if (listed) return listed.filter(row => !stage || canReadField(principal, deal, stage, row._id)).filter(row => row.updatedAt < before && open(row)).sort((a, b) => a.updatedAt - b.updatedAt || a._creationTime - b._creationTime).slice(0, limit);
  if (stage && !canQueryField(principal, deal, stage)) return [];
  return firstVisible(ctx.db.query("records").withIndex("by_object_updated", (q) => q.eq("orgId", deal.orgId).eq("objectId", deal._id).lt("updatedAt", before)), limit, row => open(row) && canReadRecord(principal, deal, row) ? row : null);
}
