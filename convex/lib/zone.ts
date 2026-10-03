import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

// A workspace's time zone (an IANA name, UTC when unset) decides where its days start and end.
// Other code, such as automations, asks here instead of doing its own date arithmetic:
// orgZone(ctx, orgId) for the name, orgDay(ctx, orgId, instant) for that instant's local day.
const DAY = 86400000, MINUTE = 60000;

// The zone name as typed when Intl accepts it. Intl's canonical form rewrites some names (Asia/Kolkata
// becomes Asia/Calcutta), so it only fixes capitalisation. Offsets such as "+05:00" are not zones.
export function validZone(name: string): string | null {
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(name)) return null;
  try { const canonical = new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone; return canonical.toLowerCase() === name.toLowerCase() ? canonical : name; } catch { return null; }
}

const formats = new Map<string, Intl.DateTimeFormat>();
// The local calendar date at `instant`, as a UTC midnight (the encoding date fields use).
export function localDate(zone: string, instant: number): number {
  let format = formats.get(zone);
  if (!format) formats.set(zone, format = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "numeric", day: "numeric" }));
  const parts = Object.fromEntries(format.formatToParts(Math.floor(instant)).map(p => [p.type, p.value]));
  return Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!);
}

// The instant the local date `day` (a UTC midnight) opens: the first whole minute whose local date
// reaches it. Offsets run from -12h to +14h, so 26h either side holds it.
export function dayStart(zone: string, day: number) {
  let lo = Math.floor((day - 26 * 3600000) / MINUTE), hi = Math.floor((day + 26 * 3600000) / MINUTE);
  while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (localDate(zone, mid * MINUTE) >= day) hi = mid; else lo = mid + 1; }
  return lo * MINUTE;
}

// The local day holding `instant`: `day` is its date as a UTC midnight, `start` the local midnight that opens
// it and `end` the next local midnight minus 1 ms, so a day with a clock change is 23 or 25 hours long.
export function zoneDay(zone: string, instant: number) {
  const day = localDate(zone, instant);
  return { day, start: dayStart(zone, day), end: dayStart(zone, day + DAY) - 1 };
}

// The instant it is `minutes` after midnight on the local date `day` (a UTC midnight): the same wall
// clock time on a day with a clock change, not a fixed number of hours after local midnight.
export function wallTime(zone: string, day: number, minutes: number) {
  const offset = (at: number) => { const d = new Date(at), p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(d).map(x => [x.type, +x.value])); return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(at / 1000) * 1000; };
  const guess = day + minutes * MINUTE;
  return Math.round(guess - offset(guess - offset(guess)));
}

// How long after local midnight the wall clock reads at `instant`, in ms (not the elapsed time on a day with a clock change).
export function wallOfDay(zone: string, instant: number) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(Math.floor(instant)).map(x => [x.type, +x.value]));
  return ((p.hour! * 60 + p.minute!) * 60 + p.second!) * 1000 + (((instant % 1000) + 1000) % 1000);
}

export const orgZone = async (ctx: Pick<QueryCtx, "db">, orgId: Id<"orgs">) => (await ctx.db.get(orgId))?.timeZone ?? "UTC";
export async function orgDay(ctx: Pick<QueryCtx, "db">, orgId: Id<"orgs">, instant: number) {
  const zone = await orgZone(ctx, orgId);
  return { zone, ...zoneDay(zone, instant) };
}
