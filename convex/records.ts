import { mutation, query } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { requireMember } from "./identity";
import { fail } from "./errors";
import { applyChange } from "./lib/applyChange";
import { listRecords } from "./lib/list";
import { canReadObject, canReadField, canReadRecord, projectRecord, requireObjectRead, requireQueryField, visibleTitle, firstVisible } from "./authority/reads";

const values = v.record(v.string(), v.any());
const direction = v.union(v.literal("asc"), v.literal("desc"));
const slotName = (kind: string, index: number) => `${kind}${index}` as const;

// A filter value of null matches records where the field is empty.
export const list = query({ args: { orgId: v.id("orgs"), objectId: v.id("objects"), sort: v.optional(v.object({ fieldId: v.id("fields"), direction })), filter: v.optional(v.object({ fieldId: v.id("fields"), value: v.any() })), paginationOpts: paginationOptsValidator }, handler: async (ctx, args) => { const principal = await requireMember(ctx, args.orgId); return listRecords(ctx, args.orgId, args.objectId, args.paginationOpts, args.sort, args.filter, principal); } });
export const get = query({ args: { orgId: v.id("orgs"), recordId: v.id("records") }, handler: async (ctx, args) => { const principal = await requireMember(ctx, args.orgId); const record = await ctx.db.get(args.recordId); if (!record || record.orgId !== args.orgId) return null; const object = await ctx.db.get(record.objectId); if (!object) return null; const fields = await ctx.db.query("fields").withIndex("by_object", (q) => q.eq("orgId", args.orgId).eq("objectId", object._id)).collect(); const masked = await projectRecord(ctx, principal, record); return masked ? { record: masked, object, fields: fields.filter(f => canReadField(principal, object, f, record._id)) } : null; } });
export const related = query({ args: { orgId: v.id("orgs"), recordId: v.id("records"), fieldId: v.id("fields"), paginationOpts: paginationOptsValidator }, handler: async (ctx, args) => {
  const principal = await requireMember(ctx, args.orgId); const target = await ctx.db.get(args.recordId); const field = await ctx.db.get(args.fieldId);
  // An unreadable target gets the same answer as a deleted one.
  const targetObject = target && target.orgId === args.orgId ? await ctx.db.get(target.objectId) : null;
  if (!target || !targetObject || !canReadRecord(principal, targetObject, target) || !field || field.orgId !== args.orgId) fail("NOT_FOUND", "Record or field not found");
  const sourceObject = await ctx.db.get(field.objectId); if (!sourceObject) fail("NOT_FOUND"); requireObjectRead(principal, sourceObject); requireQueryField(principal, sourceObject, field);
  if (field.type === "links") { const links = await ctx.db.query("links").withIndex("by_to", (q) => q.eq("orgId", args.orgId).eq("fieldId", args.fieldId).eq("toRecordId", args.recordId)).paginate(args.paginationOpts); const page = []; for (const row of links.page) { const record = await ctx.db.get(row.fromRecordId); if (record) { const masked = await projectRecord(ctx, principal, record); if (masked) page.push(masked); } } return { ...links, page }; }
  if (field.type !== "lookup" || (field.targetObjectId && field.targetObjectId !== target.objectId) || !field.slot) fail("NOT_FOUND", "Field does not relate to record");
  const index = `by_${slotName(field.slot.kind, field.slot.index)}` as any;
  const page = await (ctx.db.query("records") as any).withIndex(index, (q: any) => q.eq("orgId", args.orgId).eq("objectId", field.objectId).eq(slotName(field.slot!.kind, field.slot!.index), args.recordId)).paginate(args.paginationOpts);
  return { ...page, page: (await Promise.all(page.page.map((r: any) => projectRecord(ctx, principal, r)))).filter(Boolean) };
} });
export const reverseFields = query({ args: { orgId: v.id("orgs"), objectId: v.id("objects") }, handler: async (ctx, args) => { const principal = await requireMember(ctx, args.orgId); const object = await ctx.db.get(args.objectId); if (!object || object.orgId !== args.orgId) fail("NOT_FOUND", "Object not found"); const objects = await ctx.db.query("objects").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).collect(); const result = []; for (const source of objects.filter(o => canReadObject(principal, o))) { const fields = await ctx.db.query("fields").withIndex("by_object", (q) => q.eq("orgId", args.orgId).eq("objectId", source._id)).collect(); for (const field of fields) if (!field.retired && canReadField(principal, source, field) && (field.type === "lookup" || field.type === "links") && (!field.targetObjectId || field.targetObjectId === args.objectId)) result.push({ field, object: source }); } return result; } });
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
  const records = text
    ? ctx.db.query("records").withSearchIndex("search_title", (q) => { const base = q.search("title", text).eq("orgId", args.orgId); return args.objectId ? base.eq("objectId", args.objectId) : base; })
    : args.objectId
      ? ctx.db.query("records").withIndex("by_object_updated", (q) => q.eq("orgId", args.orgId).eq("objectId", args.objectId!)).order("desc")
      : null;
  const objects = new Map<string, { key: string; label: string }>();
  return records ? firstVisible(records, limit, async (record) => {
    if (!objects.has(record.objectId)) { const object = await ctx.db.get(record.objectId); if (object) objects.set(record.objectId, { key: object.key, label: object.label }); }
    const object = objects.get(record.objectId), masked = await projectRecord(ctx, principal, record);
    return object && masked && (!text || await visibleTitle(ctx, principal, record)) ? { _id: record._id, title: masked.title, ref: record.ref, objectKey: object.key, objectLabel: object.label } : null;
  }) : [];
} });
