import type { Doc } from "../../convex/_generated/dataModel";

export type Field = Doc<"fields">;
export type Values = Record<string, unknown>;

export const isSlotted = (field: Field) => field.slot !== undefined;

export const isEmpty = (value: unknown) =>
  value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);

const DAY = 86400000;
const pad = (n: number) => String(n).padStart(2, "0");
// A with-time value at exactly UTC midnight came from a plain date (or predates
// time of day), so it is that calendar day everywhere, not the evening before.
const allDay = (field: Field | undefined, ms: number) => !field?.withTime || ms % DAY === 0;

// Plain dates are stored as UTC midnight so every machine shows the same day;
// with-time dates are instants, edited and shown in the browser's zone.
export const dateToInput = (ms: unknown, field?: Field) => {
  if (typeof ms !== "number") return "";
  if (!field?.withTime) return new Date(ms).toISOString().slice(0, 10);
  if (allDay(field, ms)) return `${new Date(ms).toISOString().slice(0, 10)}T00:00`;
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const inputToDate = (value: string, field?: Field) => (!value ? null : field?.withTime ? new Date(value).getTime() : Date.parse(`${value}T00:00:00Z`));

// The viewer's local date, encoded as UTC midnight like plain date fields.
export const localToday = () => { const now = new Date(); return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()); };

// The local day a date falls on, encoded as UTC midnight like plain dates and "today".
export const localDay = (field: Field | undefined, ms: number) => {
  if (allDay(field, ms)) return ms;
  const d = new Date(ms);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
};

export const optionLabel = (field: Field, id: unknown) =>
  field.options?.find((option) => option.id === id)?.label ?? String(id ?? "");

export const isLongText = (field: Field) => field.type === "text" && (field.key === "body" || field.key === "notes" || field.key === "text");

// Standard contact fields become one-tap actions: call, email, open the site.
export function contactHref(field: Field, value: unknown): string | undefined {
  if (field.type !== "text" || typeof value !== "string" || !value.trim()) return undefined;
  const text = value.trim();
  if (field.key === "phone") return `tel:${text.replace(/[^\d+]/g, "")}`;
  if (field.key === "email") return `mailto:${text}`;
  if (field.key === "mediaLink" || field.key === "publishedLink") return /^https?:\/\//i.test(text) ? text : undefined;
  if (field.key === "domain" || field.key === "website" || field.key === "linkedin") return /^https?:\/\//i.test(text) ? text : `https://${text}`;
  return undefined;
}

// Short, locale-aware display: "Sep 22, 2026". Date fields are UTC midnight.
export const formatDate = (ms: unknown) =>
  typeof ms === "number" ? new Date(ms).toLocaleDateString(undefined, { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }) : "";

// "Oct 1, 2026, 2:32 PM" in the viewer's zone for with-time values; plain days as formatDate.
export const formatFieldDate = (field: Field | undefined, ms: number) =>
  allDay(field, ms) ? formatDate(ms) : new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

// Time of day alone, "2:32 PM", or null for an all-day value.
export const timeOfDay = (field: Field | undefined, ms: number) => (allDay(field, ms) ? null : new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));

// Only the standard "amount" field is money; any other number is a plain count. USD for the US launch.
export const isMoney = (field: Field) => field.type === "number" && field.key === "amount";
export const formatMoney = (amount: number) => amount.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
export const formatNumber = (field: Field, value: number) => (isMoney(field) ? formatMoney(value) : value.toLocaleString());

// How long a record has gone untouched, in one phrase used everywhere: "20 days quiet".
export const quietFor = (updatedAt: number) => `${Math.floor((Date.now() - updatedAt) / 86400000)} days quiet`;

// Event and record times, in the viewer's zone: "Sep 25, 6:50 AM".
export const formatTime = (ms: number) => new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// "Today", "Tomorrow", "2 days ago", or a weekday within the week, for due dates.
export function relativeDay(ms: number, today: number) {
  const days = Math.round((ms - today) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  if (days < 0) return `${-days} days ago`;
  if (days < 7) return new Date(ms).toLocaleDateString(undefined, { timeZone: "UTC", weekday: "short" });
  return new Date(ms).toLocaleDateString(undefined, { timeZone: "UTC", month: "short", day: "numeric" });
}

// Turns a label into a field or object key: "Close date" -> "closeDate".
export const toKey = (label: string) =>
  label.replace(/[^a-zA-Z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : "")).replace(/^[A-Z]/, (c) => c.toLowerCase());
