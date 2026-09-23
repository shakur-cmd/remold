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
