import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireWriter, requireMember } from "./identity";
import { fail } from "./errors";
import { canReadObject, canReadField, requireObjectRead } from "./authority/reads";
import { allocateSlot } from "./lib/slots";
import { unrestrictedHuman } from './authority/inbox';

const validKey = (key: string) => /^[a-z][a-zA-Z0-9]*$/.test(key);
export const list = query({ args: { orgId: v.id("orgs") }, handler: async (ctx, args) => { const principal = await requireMember(ctx, args.orgId); const rows = await ctx.db.query("objects").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).collect(); return rows.filter(o => canReadObject(principal, o)).sort((a, b) => a.order - b.order); } });
export const get = query({ args: { orgId: v.id("orgs"), objectId: v.id("objects") }, handler: async (ctx, args) => { const principal = await requireMember(ctx, args.orgId); const object = await ctx.db.get(args.objectId); if (!object || object.orgId !== args.orgId) fail("NOT_FOUND", "Object not found"); requireObjectRead(principal, object); const rows = await ctx.db.query("fields").withIndex("by_object", (q) => q.eq("orgId", args.orgId).eq("objectId", args.objectId)).collect(); const fields = []; for (const field of rows) if (!field.retired && canReadField(principal, object, field)) fields.push(field); return { object, fields: fields.sort((a, b) => a.order - b.order) }; } });
export const create = mutation({ args: { orgId: v.id("orgs"), key: v.string(), label: v.string(), labelPlural: v.string(), icon: v.optional(v.string()) }, handler: async (ctx, args) => {
  const principal = await requireWriter(ctx, args.orgId, "admin");
  if (!unrestrictedHuman(principal)) fail('FORBIDDEN', 'Unrestricted workspace access required');
  if (!validKey(args.key)) fail("VALIDATION", "Invalid object key");
  if (await ctx.db.query("objects").withIndex("by_org_key", (q) => q.eq("orgId", args.orgId).eq("key", args.key)).unique()) fail("VALIDATION", "Object key already exists");
  const order = (await ctx.db.query("objects").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).collect()).length;
  const objectId = await ctx.db.insert("objects", { ...args, isStandard: false, order });
  const fieldId = await ctx.db.insert("fields", { orgId: args.orgId, objectId, key: "name", label: "Name", type: "text", required: true, slot: await allocateSlot(ctx, args.orgId, objectId, "s"), encoding: 1, retired: false, order: 0 });
  await ctx.db.patch(objectId, { titleFieldId: fieldId });
  return objectId;
} });
