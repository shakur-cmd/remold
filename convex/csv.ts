import { internalMutation, mutation, query } from "./_generated/server";
import { requireLive } from "./lib/metadata";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { requireWriter, requireMember } from "./identity";
import { fail } from "./errors";
import { applyChange } from "./lib/applyChange";
import { isRef } from "./lib/ref";
import { findReadableByTitle } from "./lib/find";
import { allDay, instant } from "./lib/values";
import { pageRecords, whereArgs } from "./lib/list";
import { canReadField, projectRecord, requireObjectRead, canReadRecord, requireQueryField, visibleTitle, listedRecords, pageList, paginateIndex } from "./authority/reads";

const ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})/;
const US = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/;
const ISO_DAY = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
// Date.UTC rolls 2/30 into March; a real calendar date survives the round trip.
const calendar = (year: number, month: number, day: number) => { const ms = Date.UTC(year, month - 1, day), d = new Date(ms); return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? ms : undefined; };
const TRUE = new Set(["yes", "y", "true", "1", "x"]), FALSE = new Set(["no", "n", "false", "0"]);
const pad = (n: number) => String(n).padStart(2, "0");
const isoDate = (ms: number) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };

async function fieldsOf(ctx: QueryCtx, orgId: Id<"orgs">, objectId: Id<"objects">) {
  const object = await ctx.db.get(objectId);
  if (!object || object.orgId !== orgId) fail("NOT_FOUND", "Object not found");
  const fields = (await ctx.db.query("fields").withIndex("by_object", (q) => q.eq("orgId", orgId).eq("objectId", objectId)).collect()).filter((f) => !f.retired).sort((a, b) => a.order - b.order);
  return { object, fields };
}

type Run = { ctx: MutationCtx; membership: Awaited<ReturnType<typeof requireMember>>; orgId: Id<"orgs">; createMissing: boolean };

async function resolveRecord(run: Run, field: Doc<"fields">, text: string): Promise<string> {
  const { ctx, orgId } = run;
  if (isRef(text.toLowerCase())) {
    const byRef = await ctx.db.query("records").withIndex("by_org_ref", (q) => q.eq("orgId", orgId).eq("ref", text.toLowerCase())).unique();
    // An unreadable code falls through to the same outcome as an unknown one.
    if (byRef) { const object = await ctx.db.get(byRef.objectId); if (object && canReadRecord(run.membership, object, byRef)) return byRef._id; }
  }
  if (!field.targetObjectId) throw new ConvexError({ code: "VALIDATION", message: `${field.label} links to any object, so use a record code` });
  const target = await ctx.db.get(field.targetObjectId); if (!target) fail('NOT_FOUND'); requireObjectRead(run.membership, target);
  const titleField = target.titleFieldId ? await ctx.db.get(target.titleFieldId) : null;
  if (titleField) requireQueryField(run.membership, target, titleField);
  const found = await findReadableByTitle(ctx, run.membership, target, text);
  if (found) return found._id;
  if (run.createMissing && target?.titleFieldId) {
    const titleField = await ctx.db.get(target.titleFieldId);
    if (titleField?.type === "text") return (await applyChange(ctx, run.membership, { action: "create", orgId, objectId: target._id, values: { [titleField._id]: text }, reason: "Created by CSV import" })).recordId;
  }
  throw new ConvexError({ code: "VALIDATION", message: `${field.label}: no ${target?.label ?? "record"} named "${text}"` });
}

async function coerce(run: Run, field: Doc<"fields">, raw: string): Promise<unknown> {
  const text = raw.trim();
  if (!text) return undefined;
  const bad = (what: string): never => { throw new ConvexError({ code: "VALIDATION", message: `${field.label}: "${text}" ${what}` }); };
  switch (field.type) {
    case "text": return text;
    case "number": { const n = Number(text.replace(/[$,\s]/g, "")); return Number.isFinite(n) ? n : bad("is not a number"); }
    case "boolean": return TRUE.has(text.toLowerCase()) ? true : FALSE.has(text.toLowerCase()) ? false : bad("is not yes or no");
    case "date": {
      // With-time fields take a real ISO 8601 instant; a bad time never falls back to its date.
      if (field.withTime && /T/i.test(text)) { const value = instant(text); return value ?? bad("is not a time like 2026-09-22T14:30:00-04:00"); }
      // Both kinds of field then take a whole date; with-time fields refuse anything after it.
      const iso = (field.withTime ? ISO_DAY : ISO).exec(text), us = US.exec(text);
      const value = iso ? calendar(+iso[1]!, +iso[2]!, +iso[3]!) : us ? calendar(+us[3]! < 100 ? 2000 + +us[3]! : +us[3]!, +us[1]!, +us[2]!) : undefined;
      return value ?? bad("is not a real date like 2026-09-22");
    }
    case "select": {
      const option = field.options?.find((o) => o.id.toLowerCase() === text.toLowerCase() || o.label.toLowerCase() === text.toLowerCase());
      return option ? option.id : bad(`is not one of ${field.options?.map((o) => o.label).join(", ")}`);
    }
    case "lookup": return resolveRecord(run, field, text);
    case "links": { const ids = []; for (const part of text.split(";").map((p) => p.trim()).filter(Boolean)) ids.push(await resolveRecord(run, field, part)); return ids; }
  }
}

async function importTarget(ctx: MutationCtx, args: { orgId: Id<"orgs">; objectId: Id<"objects">; columns: (Id<"fields"> | null)[]; skipDuplicates: boolean }) {
    const membership = await requireWriter(ctx, args.orgId);
    const { object, fields } = await fieldsOf(ctx, args.orgId, args.objectId);
    requireObjectRead(membership, object);
    const byId = new Map(fields.map((f) => [f._id, f]));
    const columns = args.columns.map((id) => (id ? byId.get(id) ?? fail("VALIDATION", "Unknown column field") : null));
    for (const field of columns) if (field) requireQueryField(membership, object, field);
    if (args.skipDuplicates && object.titleFieldId) { const title = byId.get(object.titleFieldId); if (title) requireQueryField(membership, object, title); }
    return { membership, object, fields, columns };
}

// One batch of rows (the client sends up to 100 at a time). A bad row is
// reported by its spreadsheet row number and skipped; good rows still land.
export const importRows = mutation({
  args: { orgId: v.id("orgs"), objectId: v.id("objects"), columns: v.array(v.union(v.id("fields"), v.null())), rows: v.array(v.array(v.string())), firstRow: v.number(), skipDuplicates: v.boolean(), createMissing: v.boolean() },
  handler: async (ctx, args): Promise<{ created: number; skipped: number; errors: { row: number; message: string }[] }> => {
    if (args.rows.length > 100) fail("VALIDATION", "At most 100 rows per batch");
    const { fields, object } = await importTarget(ctx, args), byId = new Map(fields.map(f => [f._id, f]));
    requireLive(object);
    let created = 0, skipped = 0;
    const errors: { row: number; message: string }[] = [];
    for (const [index, row] of args.rows.entries()) {
      const rowNumber = args.firstRow + index;
      try {
        // A nested mutation rolls back the entire rejected row, including lookup creations.
        const result = await ctx.runMutation(internal.csv.importRow, { orgId: args.orgId, objectId: args.objectId, columns: args.columns, row, skipDuplicates: args.skipDuplicates, createMissing: args.createMissing });
        created += result.created; skipped += result.skipped;
      } catch (error) {
        const data = error instanceof ConvexError ? (error.data as { message?: string; fieldId?: string }) : null;
        const label = data?.fieldId ? byId.get(data.fieldId as Id<"fields">)?.label : undefined;
        errors.push({ row: rowNumber, message: data?.message ? (label && !data.message.startsWith(label) ? `${label}: ${data.message}` : data.message) : String(error) });
      }
    }
    return { created, skipped, errors };
  },
});

export const importRow = internalMutation({
  args: { orgId: v.id("orgs"), objectId: v.id("objects"), columns: v.array(v.union(v.id("fields"), v.null())), row: v.array(v.string()), skipDuplicates: v.boolean(), createMissing: v.boolean() },
  handler: async (ctx, args) => {
    const { membership, object, columns } = await importTarget(ctx, args);
    const run: Run = { ctx, membership, orgId: args.orgId, createMissing: args.createMissing };
    const values: Record<string, unknown> = {};
    for (const [col, field] of columns.entries()) if (field) { const value = await coerce(run, field, args.row[col] ?? ""); if (value !== undefined) values[field._id] = value; }
    const title = object.titleFieldId ? String(values[object.titleFieldId] ?? "").trim().toLowerCase() : "";
    if (args.skipDuplicates && title && await findReadableByTitle(ctx, membership, object, title)) return { created: 0, skipped: 1 };
    await applyChange(ctx, membership, { action: "create", orgId: args.orgId, objectId: object._id, values, reason: "CSV import" });
    return { created: 1, skipped: 0 };
  },
});

// One page of an export, already as spreadsheet text: select labels, dates as
// YYYY-MM-DD (with-time dates as ISO 8601 UTC), linked records by name, several links joined with "; ".
export const exportPage = query({
  args: { orgId: v.id("orgs"), objectId: v.id("objects"), cursor: v.union(v.string(), v.null()), ...whereArgs },
  handler: async (ctx, args) => {
    const principal = await requireMember(ctx, args.orgId);
    const { object, fields: allFields } = await fieldsOf(ctx, args.orgId, args.objectId);
    requireObjectRead(principal, object);
    const fields = allFields.filter(f => canReadField(principal, object, f));
    // A record-scoped reader pages their own list, so hidden rows never shorten a page.
    const listed = await listedRecords(ctx, principal, object);
    // A filtered export reads exactly what the filtered list shows.
    const page = args.filters?.length || args.range ? await pageRecords(ctx, args.orgId, args.objectId, { cursor: args.cursor, numItems: 200 }, undefined, args, principal) : listed ? pageList([...listed].sort((a, b) => a._creationTime - b._creationTime), { cursor: args.cursor, numItems: 200 }) : await paginateIndex(ctx.db.query("records").withIndex("by_object", (q) => q.eq("orgId", args.orgId).eq("objectId", args.objectId)), { cursor: args.cursor, numItems: 200 });
    const titles = new Map<string, string>();
    const titleOf = async (id: string) => {
      if (!titles.has(id)) { const normal = ctx.db.normalizeId("records", id); const record = normal ? await ctx.db.get(normal) : null; titles.set(id, record ? await visibleTitle(ctx, principal, record) : ""); }
      return titles.get(id)!;
    };
    const rows: string[][] = [];
    for (const raw of page.page) {
      const record = await projectRecord(ctx, principal, raw); if (!record) continue;
      const row = [record.ref ?? ""];
      for (const field of fields) {
        const value = record.values[field._id];
        if (value === undefined || value === null) row.push("");
        else if (field.type === "select") row.push(field.options?.find((o) => o.id === value)?.label ?? String(value));
        else if (field.type === "date") row.push(field.withTime && !allDay(value as number) ? new Date(Math.floor(value as number)).toISOString() : isoDate(value as number));
        else if (field.type === "boolean") row.push(value ? "yes" : "no");
        else if (field.type === "lookup") row.push(await titleOf(value as string));
        else if (field.type === "links") row.push((await Promise.all((value as string[]).map(titleOf))).join("; "));
        else row.push(String(value));
      }
      rows.push(row);
    }
    return { header: ["Code", ...fields.map((f) => f.label)], rows, cursor: page.continueCursor, done: page.isDone };
  },
});
