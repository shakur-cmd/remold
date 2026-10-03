import { sameText } from "./campaignText";

// Pure pieces of booking pages: the weekly hours syntax, time zones, open times,
// money, the Stripe signature and links. Nothing here reads the database.

export const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

// Weekly hours: groups split by ";", each "days times". Days are mon..sun, a range
// like mon-fri, or a list like mon,wed. Times are HH:MM-HH:MM split by ",", end after start.
// Example: "mon-fri 09:00-12:00, 13:00-17:00; sat 10:00-14:00". Keys are 0 (Sunday) to 6.
export type Hours = Record<number, [number, number][]>;
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export const HOURS_HELP = 'Write hours like "mon-fri 09:00-12:00, 13:00-17:00; sat 10:00-14:00"';
export function parseHours(text: string): Hours | null {
  const out: Hours = {}, minutes = (t: string) => { const m = /^([01]\d|2[0-4]):([0-5]\d)$/.exec(t); return m && (+m[1]! < 24 || m[2] === "00") ? +m[1]! * 60 + +m[2]! : null; };
  const groups = text.toLowerCase().split(";").map((g) => g.trim()).filter(Boolean);
  if (!groups.length) return null;
  for (const group of groups) {
    const match = /^([a-z,-]+)\s+(.+)$/.exec(group);
    if (!match) return null;
    const days = new Set<number>();
    for (const part of match[1]!.split(",")) {
      const [a, b] = part.split("-"), from = DAYS.indexOf(a ?? ""), to = b === undefined ? from : DAYS.indexOf(b);
      if (from < 0 || to < 0 || part.split("-").length > 2) return null;
      for (let d = from; ; d = (d + 1) % 7) { days.add(d); if (d === to) break; }
    }
    const ranges: [number, number][] = [];
    for (const range of match[2]!.split(",")) {
      const [s, e, extra] = range.trim().split("-"), start = minutes(s ?? ""), end = minutes(e ?? "");
      if (extra !== undefined || start === null || end === null || end <= start) return null;
      ranges.push([start, end]);
    }
    for (const d of days) out[d] = [...(out[d] ?? []), ...ranges].sort((x, y) => x[0] - y[0]);
  }
  return out;
}

const formats = new Map<string, Intl.DateTimeFormat>();
const formatter = (zone: string) => { let f = formats.get(zone); if (!f) { f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }); formats.set(zone, f); } return f; };
export const validZone = (zone: string) => { if (!zone || zone.length > 64) return false; try { formatter(zone); return true; } catch { return false; } };
// The wall clock in `zone` at an instant, as if it were UTC.
function wall(ms: number, zone: string) {
  const p = Object.fromEntries(formatter(zone).formatToParts(ms).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour! % 24, p.minute!, p.second!);
}
// The instant a local wall time names in `zone`; null in a daylight saving gap.
// A time that happens twice (the autumn change) is the first one.
export function instantOf(localAsUtc: number, zone: string) {
  const first = localAsUtc - (wall(localAsUtc, zone) - localAsUtc);
  const second = localAsUtc - (wall(first, zone) - first);
  for (const candidate of [Math.min(first, second), Math.max(first, second)]) if (wall(candidate, zone) === localAsUtc) return candidate;
  return null;
}

export type Busy = { start: number; end: number };
export type Rules = { hours: Hours; timezone: string; minutes: number; noticeHours: number; daysAhead: number };
// Open start times: inside the weekly hours in the page's zone, no sooner than the
// notice, no later than daysAhead from now, and not overlapping anything busy.
export function openSlots(rules: Rules, now: number, busy: Busy[]) {
  const length = rules.minutes * MINUTE, earliest = now + rules.noticeHours * HOUR, latest = now + rules.daysAhead * DAY;
  const today = Math.floor(wall(now, rules.timezone) / DAY) * DAY, out: number[] = [];
  for (let day = today; day <= today + (rules.daysAhead + 1) * DAY; day += DAY) {
    for (const [from, to] of rules.hours[new Date(day).getUTCDay()] ?? []) {
      for (let m = from; m + rules.minutes <= to; m += rules.minutes) {
        const start = instantOf(day + m * MINUTE, rules.timezone);
        if (start === null || start < earliest || start > latest || out.includes(start)) continue;
        if (!busy.some((b) => b.start < start + length && start < b.end)) out.push(start);
      }
    }
  }
  return out.sort((a, b) => a - b);
}

export const paymentLinkOk = (link: string) => /^https:\/\/(buy|checkout)\.stripe\.com\/[^\s]+$/.test(link);
export const payUrl = (link: string, token: string, email: string) => { const url = new URL(link); url.searchParams.set("client_reference_id", token); url.searchParams.set("prefilled_email", email); return url.toString(); };
export const money = (minor: number, currency: string) => { try { return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(minor / 100); } catch { return `${(minor / 100).toFixed(2)} ${currency.toUpperCase()}`; } };
export const when = (ms: number, zone: string) => new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(ms);
const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]|\.\d{3}/g, "");
export const calendarLink = (title: string, start: number, end: number, details: string) => `https://calendar.google.com/calendar/render?${new URLSearchParams({ action: "TEMPLATE", text: title, dates: `${stamp(start)}/${stamp(end)}`, details })}`;

// Stripe-Signature: "t=<seconds>,v1=<hex>[,v1=...]", HMAC-SHA256 over "t.body" with
// the whole signing secret as the key, five minutes either way.
export async function verifyStripe(secret: string, header: string | null, body: string, now: number) {
  const parts = (header ?? "").split(",").map((p) => p.trim().split("=")), t = parts.find(([k]) => k === "t")?.[1], v1 = parts.filter(([k, v]) => k === "v1" && v).map(([, v]) => v!);
  if (!t || !/^\d{1,12}$/.test(t) || !v1.length || Math.abs(now / 1000 - Number(t)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return v1.some((signature) => sameText(signature, expected));
}
