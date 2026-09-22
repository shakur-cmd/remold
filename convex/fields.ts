import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireMember } from "./identity";
import { fail } from "./errors";
import { allocateSlot, kindFor } from "./lib/slots";

const type = v.union(v.literal("text"), v.literal("number"), v.literal("select"), v.literal("date"), v.literal("boolean"), v.literal("lookup"), v.literal("links"));
const options = v.array(v.object({ id: v.string(), label: v.string(), color: v.optional(v.string()) }));
const validKey = (key: string) => /^[a-z][a-zA-Z0-9]*$/.test(key);
function checkOptions(value: { id: string }[] | undefined) { return !!value?.length && new Set(value.map((option) => option.id)).size === value.length; }

export const list = query({ args: { orgId: v.id("orgs"), objectId: v.id("objects") }, handler: async (ctx, args) => { await requireMember(ctx, args.orgId); const object = await ctx.db.get(args.objectId); if (!object || object.orgId !== args.orgId) fail("NOT_FOUND", "Object not found"); return (await ctx.db.query("fields").withIndex("by_object", (q) => q.eq("orgId", args.orgId).eq("objectId", args.objectId)).collect()).sort((a, b) => a.order - b.order); } });
export const create = mutation({ args: { orgId: v.id("orgs"), objectId: v.id("objects"), key: v.string(), label: v.string(), type, options: v.optional(options), targetObjectId: v.optional(v.id("objects")), required: v.optional(v.boolean()) }, handler: async (ctx, args) => {
  await requireMember(ctx, args.orgId, "admin");
  const object = await ctx.db.get(args.objectId);
  if (!object || object.orgId !== args.orgId) fail("NOT_FOUND", "Object not found");
  if (!validKey(args.key)) fail("VALIDATION", "Invalid field key");
  if (await ctx.db.query("fields").withIndex("by_object_key", (q) => q.eq("orgId", args.orgId).eq("objectId", args.objectId).eq("key", args.key)).unique()) fail("VALIDATION", "Field key already exists");
  if (args.type === "select" && !checkOptions(args.options)) fail("VALIDATION", "Select needs unique options");
  if (args.type !== "select" && args.options) fail("VALIDATION", "Only select fields have options");
  if (args.targetObjectId && args.type !== "lookup" && args.type !== "links") fail("VALIDATION", "Only relation fields have a target");
  if (args.targetObjectId) { const target = await ctx.db.get(args.targetObjectId); if (!target || target.orgId !== args.orgId) fail("NOT_FOUND", "Target object not found"); }
  const existing = await ctx.db.query("fields").withIndex("by_object", (q) => q.eq("orgId", args.orgId).eq("objectId", args.objectId)).collect();
  const kind = kindFor(args.type), slot = kind ? await allocateSlot(ctx, args.orgId, args.objectId, kind) : undefined;
  const fieldId = await ctx.db.insert("fields", { ...args, required: args.required ?? false, slot, encoding: 1, retired: false, order: existing.length });
  return { fieldId, slot };
} });
export const update = mutation({ args: { orgId: v.id("orgs"), fieldId: v.id("fields"), label: v.optional(v.string()), options: v.optional(options) }, handler: async (ctx, args) => {
  await requireMember(ctx, args.orgId, "admin");
  const field = await ctx.db.get(args.fieldId);
  if (!field || field.orgId !== args.orgId) fail("NOT_FOUND", "Field not found");
  if (args.options) {
    if (field.type !== "select" || !checkOptions(args.options)) fail("VALIDATION", "Invalid options");
    const old = new Set((field.options ?? []).map((option) => option.id));
    if ([...old].some((id) => !args.options!.some((option) => option.id === id))) fail("VALIDATION", "Options cannot be removed");
  }
  await ctx.db.patch(args.fieldId, { ...(args.label === undefined ? {} : { label: args.label }), ...(args.options === undefined ? {} : { options: args.options }) });
} });
export const retire = mutation({ args: { orgId: v.id("orgs"), fieldId: v.id("fields") }, handler: async (ctx, args) => { await requireMember(ctx, args.orgId, "admin"); const field = await ctx.db.get(args.fieldId); if (!field || field.orgId !== args.orgId) fail("NOT_FOUND", "Field not found"); const object = await ctx.db.get(field.objectId); if (object?.titleFieldId === field._id) fail("VALIDATION", "Cannot retire title field"); await ctx.db.patch(field._id, { retired: true }); } });
