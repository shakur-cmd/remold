import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { requireWriter, requireMember } from "./identity";
import { fail } from "./errors";
import { applyChange } from "./lib/applyChange";
import { isRef } from "./lib/ref";
import { findReadableByTitle } from "./lib/find";
import { canReadField, projectRecord, requireObjectRead, canReadRecord, requireQueryField, visibleTitle, listedRecords, pageList } from "./authority/reads";

const ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})/;
const US = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/;
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
      const iso = ISO.exec(text), us = US.exec(text);
      if (iso) return Date.UTC(+iso[1]!, +iso[2]! - 1, +iso[3]!);
      if (us) { const year = +us[3]! < 100 ? 2000 + +us[3]! : +us[3]!; return Date.UTC(year, +us[1]! - 1, +us[2]!); }
      return bad("is not a date like 2026-09-22");
    }
    case "select": {
      const option = field.options?.find((o) => o.id.toLowerCase() === text.toLowerCase() || o.label.toLowerCase() === text.toLowerCase());
      return option ? option.id : bad(`is not one of ${field.options?.map((o) => o.label).join(", ")}`);
    }
    case "lookup": return resolveRecord(run, field, text);
    case "links": { const ids = []; for (const part of text.split(";").map((p) => p.trim()).filter(Boolean)) ids.push(await resolveRecord(run, field, part)); return ids; }
  }
}

// One batch of rows (the client sends up to 100 at a time). A bad row is
// reported by its spreadsheet row number and skipped; good rows still land.
export const importRows = mutation({
  args: { orgId: v.id("orgs"), objectId: v.id("objects"), columns: v.array(v.union(v.id("fields"), v.null())), rows: v.array(v.array(v.string())), firstRow: v.number(), skipDuplicates: v.boolean(), createMissing: v.boolean() },
  handler: async (ctx, args) => {
    if (args.rows.length > 100) fail("VALIDATION", "At most 100 rows per batch");
    const membership = await requireWriter(ctx, args.orgId);
    const { object, fields } = await fieldsOf(ctx, args.orgId, args.objectId);
    requireObjectRead(membership, object);
    const byId = new Map(fields.map((f) => [f._id, f]));
    const columns = args.columns.map((id) => (id ? byId.get(id) ?? fail("VALIDATION", "Unknown column field") : null));
    for (const field of columns) if (field) requireQueryField(membership, object, field);
    if (args.skipDuplicates && object.titleFieldId) { const title = byId.get(object.titleFieldId); if (title) requireQueryField(membership, object, title); }
    const run: Run = { ctx, membership, orgId: args.orgId, createMissing: args.createMissing };
    const seen = new Set<string>();
    let created = 0, skipped = 0;
    const errors: { row: number; message: string }[] = [];
    for (const [index, row] of args.rows.entries()) {
      const rowNumber = args.firstRow + index;
      try {
        const values: Record<string, unknown> = {};
        for (const [col, field] of columns.entries()) if (field) { const value = await coerce(run, field, row[col] ?? ""); if (value !== undefined) values[field._id] = value; }
        const title = object.titleFieldId ? String(values[object.titleFieldId] ?? "").trim().toLowerCase() : "";
        if (args.skipDuplicates && title && (seen.has(title) || (await findReadableByTitle(ctx, membership, object, title)))) { skipped += 1; continue; }
        await applyChange(ctx, membership, { action: "create", orgId: args.orgId, objectId: object._id, values, reason: "CSV import" });
        if (title) seen.add(title);
        created += 1;
      } catch (error) {
        // Validation throws before applyChange writes, so skipping the row is safe.
        const data = error instanceof ConvexError ? (error.data as { message?: string; fieldId?: string }) : null;
        const label = data?.fieldId ? byId.get(data.fieldId as Id<"fields">)?.label : undefined;
        errors.push({ row: rowNumber, message: data?.message ? (label && !data.message.startsWith(label) ? `${label}: ${data.message}` : data.message) : String(error) });
      }
    }
    return { created, skipped, errors };
  },
});

// One page of an export, already as spreadsheet text: select labels, dates as
// YYYY-MM-DD, linked records by name, several links joined with "; ".
export const exportPage = query({
  args: { orgId: v.id("orgs"), objectId: v.id("objects"), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const principal = await requireMember(ctx, args.orgId);
    const { object, fields: allFields } = await fieldsOf(ctx, args.orgId, args.objectId);
    requireObjectRead(principal, object);
    const fields = allFields.filter(f => canReadField(principal, object, f));
    // A record-scoped reader pages their own list, so hidden rows never shorten a page.
    const listed = await listedRecords(ctx, principal, object);
    const page = listed ? pageList([...listed].sort((a, b) => a._creationTime - b._creationTime), { cursor: args.cursor, numItems: 200 }) : await ctx.db.query("records").withIndex("by_object", (q) => q.eq("orgId", args.orgId).eq("objectId", args.objectId)).paginate({ cursor: args.cursor, numItems: 200 });
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
        else if (field.type === "date") row.push(isoDate(value as number));
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
