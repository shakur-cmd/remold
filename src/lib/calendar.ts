import type { Doc } from "../../convex/_generated/dataModel";
import { type Field, localDay } from "@/lib/fields";

// Calendar days are local dates encoded as UTC midnight, like plain date values and "today".
const DAY = 86400000;
export const dayKey = (day: number) => new Date(day).toISOString().slice(0, 10);
export const parseDay = (key: string | null) => (key && /^\d{4}-\d{2}-\d{2}$/.test(key) ? Date.parse(`${key}T00:00:00Z`) : null);
const sunday = (day: number) => day - new Date(day).getUTCDay() * DAY;

export const weekDays = (anchor: number) => Array.from({ length: 7 }, (_, i) => sunday(anchor) + i * DAY);
export function monthDays(anchor: number) {
  const d = new Date(anchor), first = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), last = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0);
  const days = [];
  for (let day = sunday(first); day <= last || days.length % 7; day += DAY) days.push(day);
  return days;
}
export const shiftAnchor = (anchor: number, mode: "month" | "week", step: number) => {
  if (mode === "week") return anchor + step * 7 * DAY;
  const d = new Date(anchor);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + step, 1);
};
// Wide enough on both sides that a timed value lands in range from any time zone.
export const fetchRange = (days: number[]) => ({ from: days[0]! - DAY, to: days.at(-1)! + 2 * DAY });

export function byDay(records: Doc<"records">[], field: Field) {
  const out = new Map<number, Doc<"records">[]>();
  const at = (r: Doc<"records">) => r.values[field._id] as number;
  for (const record of [...records].filter((r) => typeof at(r) === "number").sort((a, b) => at(a) - at(b))) {
    const day = localDay(field, at(record));
    out.set(day, [...(out.get(day) ?? []), record]);
  }
  return out;
}

// The same value on another day: a timed value keeps its local wall-clock time,
// an all-day value becomes that day.
export function moveToDay(field: Field, ms: number, day: number) {
  if (localDay(field, ms) === ms) return day;
  const from = new Date(ms), to = new Date(day);
  return new Date(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate(), from.getHours(), from.getMinutes(), from.getSeconds(), from.getMilliseconds()).getTime();
}

// One color per select option, by its position.
const SWATCHES = ["bg-sky-500", "bg-amber-500", "bg-violet-500", "bg-emerald-500", "bg-slate-400", "bg-rose-500", "bg-teal-500", "bg-orange-500", "bg-fuchsia-500", "bg-lime-500"];
export const swatch = (field: Field | undefined, value: unknown) => {
  const index = field?.options?.findIndex((option) => option.id === value) ?? -1;
  return index < 0 ? "bg-muted-foreground/40" : SWATCHES[index % SWATCHES.length]!;
};
