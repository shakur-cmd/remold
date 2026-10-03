import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { fail } from "../errors";
import { findReadableByTitle } from "./find";
import { isRef } from "./ref";
import { assigneeOf, resolveAssignee } from "./assignee";
import type { Principal } from "../identity";
import { canReadField, canReadRecord, requireObjectRead, requireRecordRead, requireQueryField, visibleTitle } from "../authority/reads";

type Ctx = QueryCtx | MutationCtx;
export type ApiRecord = { id: string; ref: string | null; object: string; title: string; createdAt: number; updatedAt: number; values: Record<string, unknown> };
const empty = (value: unknown) => value === null || value === undefined;
const pad = (value: number) => String(value).padStart(2, "0");
const dateText = (value: number) => { const d = new Date(value); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
const supported = (ms: number) => Number.isFinite(ms) && ms >= Date.UTC(1000, 0, 1) && ms < Date.UTC(10000, 0, 1);
const day = (value: string) => { const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(value); if (!match) return undefined; const ms = Date.UTC(+match[1]!, +match[2]! - 1, +match[3]!); return supported(ms) && dateText(ms) === value.slice(0, 10) ? ms : undefined; };
// With-time date fields hold two kinds of value. A plain date is a whole UTC
// midnight, as on plain date fields. An instant is never stored as one: an
// instant at exactly 00:00Z is kept as midnight + 0.5 ms, the only fractional
// value, so the two kinds never collide and readers floor instants to the ms.
const DAY = 86400000, sinceMidnight = (ms: number) => ((ms % DAY) + DAY) % DAY;
export const allDay = (ms: number) => Number.isInteger(ms) && sinceMidnight(ms) === 0;
export const fromInstant = (ms: number) => (allDay(ms) ? ms + 0.5 : ms);
export const dateValue = (field: Doc<"fields">, value: unknown) => typeof value === "number" && supported(value) && (Number.isInteger(value) || (!!field.withTime && sinceMidnight(value) === 0.5));
// The instant a text names, exactly; a time without an offset names no instant, so it is
// refused rather than a zone guessed. Query bounds use this as is. Stored values go through
// instant(), which keeps an instant at 00:00Z off the all-day encoding (midnight + 0.5 ms).
export const instantBound = (value: string) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return day(value);
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})$/.exec(value);
  if (!match || day(match[1]!) === undefined || +match[2]! > 23 || +match[3]! > 59 || +(match[4] ?? 0) > 59) return undefined;
  const ms = Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return supported(ms) ? ms : undefined;
};
export const instant = (value: string) => { const ms = instantBound(value); return ms === undefined || /^\d{4}-\d{2}-\d{2}$/.test(value) ? ms : fromInstant(ms); };

// Turns a "@name" reference into a record id, or into a stand-in when the record does not exist yet (import dry run).
export type Pending = (field: Doc<"fields">, name: string, fieldKey: string) => { id: string } | { standIn: string };

async function related(ctx: Ctx, principal: Principal, field: Doc<"fields">, value: unknown, fieldKey: string, pending?: Pending): Promise<Id<"records">> {
  const orgId = principal.org._id;
  if (field.targetObjectId) { const target = await ctx.db.get(field.targetObjectId); if (!target) fail("NOT_FOUND"); requireObjectRead(principal, target); }
  if (typeof value !== "string") fail("VALIDATION", "Expected record", { fieldKey });
  if (pending && value.startsWith("@")) { const resolved = pending(field, value.slice(1), fieldKey); return "standIn" in resolved ? resolved.standIn as Id<"records"> : related(ctx, principal, field, resolved.id, fieldKey); }
  const id = ctx.db.normalizeId("records", value);
  const direct = id && await ctx.db.get(id);
  // Unreadable matches fall through, so every miss ends in the same error as a record that does not exist.
  const readableTarget = async (record: Doc<"records">) => { const target = await ctx.db.get(record.objectId); return !!target && canReadRecord(principal, target, record); };
  if (direct && direct.orgId === orgId && (!field.targetObjectId || direct.objectId === field.targetObjectId) && await readableTarget(direct)) return direct._id;
  if (isRef(value.trim().toLowerCase())) {
    const record = await ctx.db.query("records").withIndex("by_org_ref", (q) => q.eq("orgId", orgId).eq("ref", value.trim().toLowerCase())).unique();
    if (record && (!field.targetObjectId || record.objectId === field.targetObjectId) && await readableTarget(record)) return record._id;
  }
  if (field.targetObjectId) {
    const object = await ctx.db.get(field.targetObjectId), title = object?.titleFieldId ? await ctx.db.get(object.titleFieldId) : null;
    if (object && title) requireQueryField(principal, object, title);
    const record = object ? await findReadableByTitle(ctx, principal, object, value) : null;
    if (record) return record._id;
    fail("VALIDATION", `No ${object?.label ?? "record"} named ${JSON.stringify(value)}`, { fieldKey });
  }
  fail("VALIDATION", "Polymorphic lookup needs a record id or code", { fieldKey });
}

function scalar(field: Doc<"fields">, value: unknown, fieldKey: string) {
  if (empty(value)) return null;
  if (field.type === "text") { if (typeof value !== "string") fail("VALIDATION", "Expected text", { fieldKey }); return value; }
  if (field.type === "number") { const number = typeof value === "number" ? value : typeof value === "string" ? Number(value.replace(/[$,\s]/g, "")) : NaN; if (!Number.isFinite(number)) fail("VALIDATION", "Expected a finite number", { fieldKey }); return number; }
  if (field.type === "boolean") { if (typeof value === "boolean") return value; if (typeof value === "string") { const normalized = value.toLowerCase(); if (["true", "yes"].includes(normalized)) return true; if (["false", "no"].includes(normalized)) return false; } fail("VALIDATION", "Expected boolean", { fieldKey }); }
  if (field.type === "date") { if (dateValue(field, value)) return value; if (typeof value === "string") { const ms = field.withTime ? instant(value) : day(value); if (ms !== undefined) return ms; } fail("VALIDATION", field.withTime ? "Expected YYYY-MM-DD or an ISO 8601 time with an offset" : "Expected a real date as YYYY-MM-DD", { fieldKey }); }
  if (field.type === "select") { if (typeof value !== "string") fail("VALIDATION", "Expected select option", { fieldKey }); const option = field.options?.find((item) => item.id === value || item.label.toLowerCase() === value.toLowerCase()); if (!option) fail("VALIDATION", "Invalid select option", { fieldKey }); return option.id; }
  return value;
}

export async function resolveValues(ctx: Ctx, principal: Principal, _object: Doc<"objects">, fields: Doc<"fields">[], input: Record<string, unknown>, pending?: Pending, mode: "write" | "filter" = "write") {
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const values: Record<string, unknown> = {};
  for (const [fieldKey, inputValue] of Object.entries(input)) {
    const field = byKey.get(fieldKey);
    if (!field || field.retired || !canReadField(principal, _object, field)) fail("VALIDATION", `Unknown field \"${fieldKey}\"`, { fieldKey });
    if (_object.key === "task" && field.key === "assignee") values[field._id] = empty(inputValue) ? null : await resolveAssignee(ctx, principal, inputValue, fieldKey, mode);
    else if (field.type === "lookup") values[field._id] = empty(inputValue) ? null : await related(ctx, principal, field, inputValue, fieldKey, pending);
    else if (field.type === "links") { if (empty(inputValue)) values[field._id] = null; else { if (!Array.isArray(inputValue)) fail("VALIDATION", "Expected record array", { fieldKey }); values[field._id] = await Promise.all(inputValue.map((value) => related(ctx, principal, field, value, fieldKey, pending))); } }
    else values[field._id] = scalar(field, inputValue, fieldKey);
  }
  return values;
}

export async function readableValue(ctx: Ctx, principal: Principal, field: Doc<"fields">, value: unknown) {
  if (empty(value)) return undefined;
  if (field.type === "number" || field.type === "text" || field.type === "boolean" || field.type === "select") return value;
  if (field.type === "date") return field.withTime && !allDay(value as number) ? new Date(Math.floor(value as number)).toISOString() : dateText(value as number);
  const reference = async (id: string) => {
    const normal = ctx.db.normalizeId("records", id), record = normal ? await ctx.db.get(normal) : null;
    if (!record || record.orgId !== principal.org._id) return null;
    const object = await ctx.db.get(record.objectId);
    if (!object || !canReadRecord(principal, object, record)) return { id: record._id };
    return { id: record._id, ref: record.ref ?? null, title: await visibleTitle(ctx, principal, record) };
  };
  if (field.type === "lookup") return typeof value === "string" ? reference(value) : null;
  if (field.type === "links") return Promise.all(((value as string[]) ?? []).map(reference)).then(items => items.filter(Boolean));
  return value;
}

export async function readable(ctx: Ctx, principal: Principal, record: Doc<"records">, object: Doc<"objects">, fields: Doc<"fields">[]): Promise<ApiRecord> {
  requireRecordRead(principal, object, record);
  const values: Record<string, unknown> = {};
  for (const field of fields) if (!field.retired && canReadField(principal, object, field, record._id)) { const raw = record.values[field._id], value = object.key === "task" && field.key === "assignee" ? (await assigneeOf(ctx, principal.org._id, raw)) ?? (empty(raw) ? undefined : { id: raw, name: null, kind: null }) : await readableValue(ctx, principal, field, raw); if (value !== undefined) values[field.key] = value; }
  return { id: record._id, ref: record.ref ?? null, object: object.key, title: await visibleTitle(ctx, principal, record), createdAt: record._creationTime, updatedAt: record.updatedAt, values };
}

// Suggestion payloads keep an explicit null: "clear this field" must survive JSON.
export async function readableMap(ctx: Ctx, principal: Principal, fields: Doc<"fields">[], values: Record<string, unknown>) {
  const byId = new Map(fields.map((field) => [field._id as string, field]));
  const out: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(values)) { const field = byId.get(id); if (!field) continue; const object = await ctx.db.get(field.objectId); if (!object || !canReadField(principal, object, field)) continue; out[field.key] = (object.key === "task" && field.key === "assignee" ? (await assigneeOf(ctx, principal.org._id, value)) ?? (empty(value) ? undefined : { id: value, name: null, kind: null }) : await readableValue(ctx, principal, field, value)) ?? null; }
  return out;
}
