// Calendar days ("YYYY-MM-DD") in a time zone and the instants that bound them. Pure,
// so the app (in the browser's zone) and the server (in a zone the caller names)
// resolve a view's relative range the same way. Days are encoded as UTC midnights.
export type Relative = "today" | "next7" | "thisMonth" | "overdue";
export const relativeLabels: Record<Relative, string> = { today: "today", next7: "next 7 days", thisMonth: "this month", overdue: "overdue" };
const DAY = 86400000, HOUR = 3600000;
const key = (midnight: number) => new Date(midnight).toISOString().slice(0, 10);
const utc = (day: string) => Date.parse(`${day}T00:00:00Z`);

function wall(ms: number, timeZone: string) {
  let format: Intl.DateTimeFormat;
  try { format = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }); }
  catch { throw new RangeError(`Unknown time zone ${timeZone}`); }
  const p = Object.fromEntries(format.formatToParts(ms).map((part) => [part.type, Number(part.value)]));
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
}
export const knownZone = (timeZone: string) => { try { new Intl.DateTimeFormat("en-US", { timeZone }); return true; } catch { return false; } };
// The UTC midnight of the date `ms` falls on in `timeZone`.
const dayIn = (ms: number, timeZone: string) => Math.floor(wall(ms, timeZone) / DAY) * DAY;
// The instant `day` starts in `timeZone`: its UTC midnight less the offset the zone had
// 14 hours earlier, before any clock change that night. Zones change clocks at or after
// midnight, so this is midnight, or the jump itself where clocks skip midnight.
const startOf = (day: string, timeZone: string) => { const before = utc(day) - 14 * HOUR; return utc(day) - (wall(before, timeZone) - Math.floor(before / 1000) * 1000); };

// Next 7 days is today and the six after it; overdue is every day before today.
export function relativeDays(relative: Relative, now: number, timeZone: string): { from?: string; to?: string } {
  const today = dayIn(now, timeZone), d = new Date(today);
  switch (relative) {
    case "today": return { from: key(today), to: key(today) };
    case "next7": return { from: key(today), to: key(today + 6 * DAY) };
    case "thisMonth": return { from: key(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)), to: key(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)) };
    case "overdue": return { to: key(today - DAY) };
  }
}

// List bounds for whole days. A plain date compares by date; a with-time field takes
// instants from the first day's local midnight to just before the midnight after the
// last, and all-day values by their date, which is what `days` carries.
export function dayBounds(field: { withTime?: boolean }, from: string | undefined, to: string | undefined, timeZone: string) {
  if (!field.withTime) return { ...(from ? { from: utc(from) } : {}), ...(to ? { to: utc(to) } : {}) };
  return {
    ...(from ? { from: startOf(from, timeZone) } : {}),
    ...(to ? { to: startOf(key(utc(to) + DAY), timeZone) - 1 } : {}),
    ...(from || to ? { days: { ...(from ? { from: utc(from) } : {}), ...(to ? { to: utc(to) } : {}) } } : {}),
  };
}
