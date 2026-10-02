import { mutation, query } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { requireMember } from "./identity";
import { fail } from "./errors";
import { applyChange } from "./lib/applyChange";
import { listRecords, listedRelated, totals as groupTotals, filter, whereArgs } from "./lib/list";
import { searchRecords } from "./lib/search";
import { canReadObject, canReadField, canReadRecord, canQueryField, projectRecord, requireObjectRead, requireQueryField, pageList, paginateIndex } from "./authority/reads";

const values = v.record(v.string(), v.any());
const direction = v.union(v.literal("asc"), v.literal("desc"));
const slotName = (kind: string, index: number) => `${kind}${index}` as const;

// A filter value of null matches records where the field is empty.
export const list = query({ args: { orgId: v.id("orgs"), objectId: v.id("objects"), sort: v.optional(v.object({ fieldId: v.id("fields"), direction })), filter: v.optional(filter), ...whereArgs, paginationOpts: paginationOptsValidator }, handler: async (ctx, args) => { const principal = await requireMember(ctx, args.orgId); return listRecords(ctx, args.orgId, args.objectId, args.paginationOpts, args.sort, { filters: [...(args.filter ? [args.filter] : []), ...(args.filters ?? [])], range: args.range }, principal); } });
// Board column headers: count and summed number per option, for the whole board, not just the loaded cards.
export const totals = query({ args: { orgId: v.id("orgs"), objectId: v.id("objects"), groupFieldId: v.id("fields"), sumFieldId: v.optional(v.id("fields")), ...whereArgs }, handler: async (ctx, args) => groupTotals(ctx, await requireMember(ctx, args.orgId), args.orgId, args.objectId, args.groupFieldId, args.sumFieldId, { filters: args.filters, range: args.range }) });
export const get = query({ args: { orgId: v.id("orgs"), recordId: v.id("records") }, handler: async (ctx, args) => { const principal = await requireMember(ctx, args.orgId); const record = await ctx.db.get(args.recordId); if (!record || record.orgId !== args.orgId) return null; const object = await ctx.db.get(record.objectId); if (!object) return null; const fields = await ctx.db.query("fields").withIndex("by_object", (q) => q.eq("orgId", args.orgId).eq("objectId", object._id)).collect(); const masked = await projectRecord(ctx, principal, record); return masked ? { record: masked, object, fields: fields.filter(f => canReadField(principal, object, f, record._id)) } : null; } });
export const related = query({ args: { orgId: v.id("orgs"), recordId: v.id("records"), fieldId: v.id("fields"), paginationOpts: paginationOptsValidator }, handler: async (ctx, args) => {
  const principal = await requireMember(ctx, args.orgId); const target = await ctx.db.get(args.recordId); const field = await ctx.db.get(args.fieldId);
  // An unreadable target gets the same answer as a deleted one.
  const targetObject = target && target.orgId === args.orgId ? await ctx.db.get(target.objectId) : null;
  if (!target || !targetObject || !canReadRecord(principal, targetObject, target) || !field || field.orgId !== args.orgId) fail("NOT_FOUND", "Record or field not found");
  const sourceObject = await ctx.db.get(field.objectId); if (!sourceObject) fail("NOT_FOUND"); requireObjectRead(principal, sourceObject); requireQueryField(principal, sourceObject, field);
  if (field.type !== "links" && (field.type !== "lookup" || (field.targetObjectId && field.targetObjectId !== target.objectId) || !field.slot)) fail("NOT_FOUND", "Field does not relate to record");
  const listed = await listedRelated(ctx, principal, sourceObject, field, target._id);
  if (listed) { const page = pageList(listed, args.paginationOpts); return { ...page, page: (await Promise.all(page.page.map(r => projectRecord(ctx, principal, r)))).filter(Boolean) }; }
  if (field.type === "links") { const links = await paginateIndex(ctx.db.query("links").withIndex("by_to", (q) => q.eq("orgId", args.orgId).eq("fieldId", args.fieldId).eq("toRecordId", args.recordId)), args.paginationOpts); const page = []; for (const row of links.page) { const record = await ctx.db.get(row.fromRecordId); if (record) { const masked = await projectRecord(ctx, principal, record); if (masked) page.push(masked); } } return { ...links, page }; }
  const index = `by_${slotName(field.slot!.kind, field.slot!.index)}` as any;
  const page = await paginateIndex((ctx.db.query("records") as any).withIndex(index, (q: any) => q.eq("orgId", args.orgId).eq("objectId", field.objectId).eq(slotName(field.slot!.kind, field.slot!.index), args.recordId)), args.paginationOpts);
  return { ...page, page: (await Promise.all(page.page.map((r: any) => projectRecord(ctx, principal, r)))).filter(Boolean) };
} });
export const reverseFields = query({ args: { orgId: v.id("orgs"), objectId: v.id("objects") }, handler: async (ctx, args) => { const principal = await requireMember(ctx, args.orgId); const object = await ctx.db.get(args.objectId); if (!object || object.orgId !== args.orgId) fail("NOT_FOUND", "Object not found"); const objects = await ctx.db.query("objects").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).collect(); const result = []; for (const source of objects.filter(o => canReadObject(principal, o))) { const fields = await ctx.db.query("fields").withIndex("by_object", (q) => q.eq("orgId", args.orgId).eq("objectId", source._id)).collect(); for (const field of fields) if (!field.retired && canReadField(principal, source, field) && (field.type === "lookup" || field.type === "links") && (!field.targetObjectId || field.targetObjectId === args.objectId)) result.push({ field, object: source }); } return result; } });
// Activities, notes and tasks whose About points at this record, for its timeline.
// Each kind is capped at its newest TIMELINE_CAP by creation.
const TIMELINE_CAP = 200;
export const timeline = query({ args: { orgId: v.id("orgs"), recordId: v.id("records") }, handler: async (ctx, args) => {
  const principal = await requireMember(ctx, args.orgId); const target = await ctx.db.get(args.recordId);
  const targetObject = target && target.orgId === args.orgId ? await ctx.db.get(target.objectId) : null;
  if (!target || !targetObject || !canReadRecord(principal, targetObject, target)) fail("NOT_FOUND", "Record not found");
  const items = [];
  for (const kind of ["activity", "note", "task"] as const) {
    const object = await ctx.db.query("objects").withIndex("by_org_key", (q) => q.eq("orgId", args.orgId).eq("key", kind)).unique();
    if (!object || !canReadObject(principal, object)) continue;
    const byKey = new Map((await ctx.db.query("fields").withIndex("by_object", (q) => q.eq("orgId", args.orgId).eq("objectId", object._id)).collect()).filter((f) => !f.retired).map((f) => [f.key, f]));
    const about = byKey.get("about");
    if (!about || about.type !== "lookup" || about.targetObjectId || !about.slot || !canQueryField(principal, object, about)) continue;
    const name = slotName(about.slot.kind, about.slot.index);
    const rows = (await listedRelated(ctx, principal, object, about, target._id))?.reverse() ?? await (ctx.db.query("records") as any).withIndex(`by_${name}`, (q: any) => q.eq("orgId", args.orgId).eq("objectId", object._id).eq(name, target._id)).order("desc").take(TIMELINE_CAP) as Doc<"records">[];
    for (const row of rows.slice(0, TIMELINE_CAP)) {
      const record = await projectRecord(ctx, principal, row); if (!record) continue;
      const value = (key: string) => { const field = byKey.get(key); return field ? record.values[field._id] : undefined; };
      const when = value("when"), due = value("dueDate"), type = byKey.get("type");
      items.push({ _id: record._id, kind, objectKey: object.key, title: record.title, createdAt: record._creationTime, at: typeof when === "number" ? when : record._creationTime,
        ...(kind === "activity" ? { type: type && value("type") !== undefined ? type.options?.find((o) => o.id === value("type"))?.label ?? String(value("type")) : null, source: (value("source") as string | undefined) ?? null } : {}),
        ...(kind === "task" ? { due: typeof due === "number" ? due : null, dueWithTime: !!byKey.get("dueDate")?.withTime, done: value("done") === true } : {}) });
    }
  }
  return items.sort((a, b) => b.at - a.at);
} });
export const create = mutation({ args: { orgId: v.id("orgs"), objectId: v.id("objects"), values, reason: v.optional(v.string()) }, handler: async (ctx, args) => applyChange(ctx, await requireMember(ctx, args.orgId), { action: "create", ...args }) });
export const update = mutation({ args: { orgId: v.id("orgs"), recordId: v.id("records"), values, reason: v.optional(v.string()) }, handler: async (ctx, args) => applyChange(ctx, await requireMember(ctx, args.orgId), { action: "update", ...args }) });
export const remove = mutation({ args: { orgId: v.id("orgs"), recordId: v.id("records"), reason: v.optional(v.string()) }, handler: async (ctx, args) => applyChange(ctx, await requireMember(ctx, args.orgId), { action: "delete", ...args }) });
// Exact lookup by three-word code, for people and agents pasting a code.
export const byRef = query({ args: { orgId: v.id("orgs"), ref: v.string() }, handler: async (ctx, args) => {
  const principal = await requireMember(ctx, args.orgId);
  const record = await ctx.db.query("records").withIndex("by_org_ref", (q) => q.eq("orgId", args.orgId).eq("ref", args.ref.trim().toLowerCase())).unique();
  if (!record) return null;
  const object = await ctx.db.get(record.objectId);
  const masked = await projectRecord(ctx, principal, record);
  return object && masked ? { record: masked, object } : null;
} });
// Title search for pickers and the search box. Without text it returns the
// most recently updated, so a picker is never empty.
export const search = query({ args: { orgId: v.id("orgs"), objectId: v.optional(v.id("objects")), text: v.string(), limit: v.optional(v.number()) }, handler: async (ctx, args) => {
  const principal = await requireMember(ctx, args.orgId);
  const limit = Math.min(args.limit ?? 10, 50), text = args.text.trim();
  if (args.objectId) { const object = await ctx.db.get(args.objectId); if (!object || object.orgId !== args.orgId) fail("NOT_FOUND", "Object not found"); }
  const records = await searchRecords(ctx, principal, text, args.objectId, limit);
  const objects = new Map<string, { key: string; label: string }>();
  const result = [];
  for (const record of records) {
    if (!objects.has(record.objectId)) { const object = await ctx.db.get(record.objectId); if (object) objects.set(record.objectId, { key: object.key, label: object.label }); }
    const object = objects.get(record.objectId), masked = await projectRecord(ctx, principal, record);
    if (object && masked) result.push({ _id: record._id, title: masked.title, ref: record.ref, objectKey: object.key, objectLabel: object.label });
  }
  return result;
} });
