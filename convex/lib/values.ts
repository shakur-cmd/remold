import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { fail } from "../errors";
import { findByTitle } from "./find";
import { isRef } from "./ref";
import type { Principal } from "../identity";
import { canReadField, canReadRecord, requireObjectRead, requireRecordRead, requireQueryField, visibleTitle } from "../authority/reads";

type Ctx = QueryCtx | MutationCtx;
export type ApiRecord = { id: string; ref: string | null; object: string; title: string; createdAt: number; updatedAt: number; values: Record<string, unknown> };
const empty = (value: unknown) => value === null || value === undefined;
const pad = (value: number) => String(value).padStart(2, "0");
const dateText = (value: number) => { const d = new Date(value); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };

async function related(ctx: Ctx, principal: Principal, field: Doc<"fields">, value: unknown, fieldKey: string) {
  const orgId = principal.org._id;
  if (field.targetObjectId) { const target = await ctx.db.get(field.targetObjectId); if (!target) fail("NOT_FOUND"); requireObjectRead(principal, target); }
  if (typeof value !== "string") fail("VALIDATION", "Expected record", { fieldKey });
  const id = ctx.db.normalizeId("records", value);
  const direct = id && await ctx.db.get(id);
  if (direct && direct.orgId === orgId && (!field.targetObjectId || direct.objectId === field.targetObjectId)) { const target = await ctx.db.get(direct.objectId); if (!target) fail("NOT_FOUND"); requireRecordRead(principal, target, direct); return direct._id; }
  if (isRef(value.trim().toLowerCase())) {
    const record = await ctx.db.query("records").withIndex("by_org_ref", (q) => q.eq("orgId", orgId).eq("ref", value.trim().toLowerCase())).unique();
    if (record && (!field.targetObjectId || record.objectId === field.targetObjectId)) { const target = await ctx.db.get(record.objectId); if (!target) fail("NOT_FOUND"); requireRecordRead(principal, target, record); return record._id; }
  }
  if (field.targetObjectId) {
    const object = await ctx.db.get(field.targetObjectId), title = object?.titleFieldId ? await ctx.db.get(object.titleFieldId) : null;
    if (object && title) requireQueryField(principal, object, title);
    const record = await findByTitle(ctx, orgId, field.targetObjectId, value);
    if (record) { const target = await ctx.db.get(record.objectId); if (!target) fail("NOT_FOUND"); requireRecordRead(principal, target, record); return record._id; }
    const target = await ctx.db.get(field.targetObjectId);
    fail("VALIDATION", `No ${target?.label ?? "record"} named ${JSON.stringify(value)}`, { fieldKey });
  }
  fail("VALIDATION", "Polymorphic lookup needs a record id or code", { fieldKey });
}

function scalar(field: Doc<"fields">, value: unknown, fieldKey: string) {
  if (empty(value)) return null;
  if (field.type === "text") { if (typeof value !== "string") fail("VALIDATION", "Expected text", { fieldKey }); return value; }
  if (field.type === "number") { const number = typeof value === "number" ? value : typeof value === "string" ? Number(value.replace(/[$,\s]/g, "")) : NaN; if (!Number.isFinite(number)) fail("VALIDATION", "Expected a finite number", { fieldKey }); return number; }
  if (field.type === "boolean") { if (typeof value === "boolean") return value; if (typeof value === "string") { const normalized = value.toLowerCase(); if (["true", "yes"].includes(normalized)) return true; if (["false", "no"].includes(normalized)) return false; } fail("VALIDATION", "Expected boolean", { fieldKey }); }
  if (field.type === "date") { if (typeof value === "number" && Number.isInteger(value)) return value; if (typeof value === "string") { const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(value); if (match) { const ms = Date.UTC(+match[1]!, +match[2]! - 1, +match[3]!); if (dateText(ms) === value.slice(0, 10)) return ms; } } fail("VALIDATION", "Expected a real date as YYYY-MM-DD", { fieldKey }); }
  if (field.type === "select") { if (typeof value !== "string") fail("VALIDATION", "Expected select option", { fieldKey }); const option = field.options?.find((item) => item.id === value || item.label.toLowerCase() === value.toLowerCase()); if (!option) fail("VALIDATION", "Invalid select option", { fieldKey }); return option.id; }
  return value;
}

export async function resolveValues(ctx: Ctx, principal: Principal, _object: Doc<"objects">, fields: Doc<"fields">[], input: Record<string, unknown>) {
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const values: Record<string, unknown> = {};
  for (const [fieldKey, inputValue] of Object.entries(input)) {
    const field = byKey.get(fieldKey);
    if (!field || field.retired || !canReadField(principal, _object, field)) fail("VALIDATION", `Unknown field \"${fieldKey}\"`, { fieldKey });
    if (field.type === "lookup") values[field._id] = empty(inputValue) ? null : await related(ctx, principal, field, inputValue, fieldKey);
    else if (field.type === "links") { if (empty(inputValue)) values[field._id] = null; else { if (!Array.isArray(inputValue)) fail("VALIDATION", "Expected record array", { fieldKey }); values[field._id] = await Promise.all(inputValue.map((value) => related(ctx, principal, field, value, fieldKey))); } }
    else values[field._id] = scalar(field, inputValue, fieldKey);
  }
  return values;
}

export async function readableValue(ctx: Ctx, principal: Principal, field: Doc<"fields">, value: unknown) {
  if (empty(value)) return undefined;
  if (field.type === "number" || field.type === "text" || field.type === "boolean" || field.type === "select") return value;
  if (field.type === "date") return dateText(value as number);
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
  for (const field of fields) if (!field.retired && canReadField(principal, object, field, record._id)) { const value = await readableValue(ctx, principal, field, record.values[field._id]); if (value !== undefined) values[field.key] = value; }
  return { id: record._id, ref: record.ref ?? null, object: object.key, title: await visibleTitle(ctx, principal, record), createdAt: record._creationTime, updatedAt: record.updatedAt, values };
}

// Suggestion payloads keep an explicit null: "clear this field" must survive JSON.
export async function readableMap(ctx: Ctx, principal: Principal, fields: Doc<"fields">[], values: Record<string, unknown>) {
  const byId = new Map(fields.map((field) => [field._id as string, field]));
  const out: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(values)) { const field = byId.get(id); if (!field) continue; const object = await ctx.db.get(field.objectId); if (!object || !canReadField(principal, object, field)) continue; out[field.key] = (await readableValue(ctx, principal, field, value)) ?? null; }
  return out;
}
