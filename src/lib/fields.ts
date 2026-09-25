import type { Doc } from "../../convex/_generated/dataModel";

export type Field = Doc<"fields">;
export type Values = Record<string, unknown>;

export const isSlotted = (field: Field) => field.slot !== undefined;

export const isEmpty = (value: unknown) =>
  value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);

export const dateToInput = (ms: unknown) => (typeof ms === "number" ? new Date(ms).toISOString().slice(0, 10) : "");

// Dates are stored as UTC midnight so every machine shows the same day.
export const inputToDate = (value: string) => (value ? Date.parse(`${value}T00:00:00Z`) : null);

export const optionLabel = (field: Field, id: unknown) =>
  field.options?.find((option) => option.id === id)?.label ?? String(id ?? "");

export const isLongText = (field: Field) => field.type === "text" && (field.key === "body" || field.key === "notes");

// Standard contact fields become one-tap actions: call, email, open the site.
export function contactHref(field: Field, value: unknown): string | undefined {
  if (field.type !== "text" || typeof value !== "string" || !value.trim()) return undefined;
  const text = value.trim();
  if (field.key === "phone") return `tel:${text.replace(/[^\d+]/g, "")}`;
  if (field.key === "email") return `mailto:${text}`;
  if (field.key === "domain" || field.key === "website" || field.key === "linkedin") return /^https?:\/\//i.test(text) ? text : `https://${text}`;
  return undefined;
}

// Short, locale-aware display: "Sep 22, 2026". Date fields are UTC midnight.
export const formatDate = (ms: unknown) =>
  typeof ms === "number" ? new Date(ms).toLocaleDateString(undefined, { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }) : "";

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
