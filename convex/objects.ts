import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireWriter, requireMember } from "./identity";
import { fail } from "./errors";
import { canReadObject, canReadField, requireObjectAdministration, requireObjectRead } from "./authority/reads";
import { createObject, objectSpec } from "./lib/metadata";
import { applyLifecycle, impactOf } from "./lib/lifecycle";

export const list = query({ args: { orgId: v.id("orgs") }, handler: async (ctx, args) => { const principal = await requireMember(ctx, args.orgId); const rows = await ctx.db.query("objects").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).collect(); return rows.filter(o => canReadObject(principal, o)).sort((a, b) => a.order - b.order); } });
export const get = query({ args: { orgId: v.id("orgs"), objectId: v.id("objects") }, handler: async (ctx, args) => { const principal = await requireMember(ctx, args.orgId); const object = await ctx.db.get(args.objectId); if (!object || object.orgId !== args.orgId) fail("NOT_FOUND", "Object not found"); requireObjectRead(principal, object); const rows = await ctx.db.query("fields").withIndex("by_object", (q) => q.eq("orgId", args.orgId).eq("objectId", args.objectId)).collect(); const fields = []; for (const field of rows) if (!field.retired && canReadField(principal, object, field)) fields.push(field); return { object, fields: fields.sort((a, b) => a.order - b.order) }; } });
export const create = mutation({ args: { orgId: v.id("orgs"), ...objectSpec }, handler: async (ctx, { orgId, ...spec }) => (await createObject(ctx, await requireWriter(ctx, orgId, "admin"), spec)).objectId });
export const reorder = mutation({ args: { orgId: v.id("orgs"), objectIds: v.array(v.id("objects")) }, handler: async (ctx, args) => { await applyLifecycle(ctx, await requireWriter(ctx, args.orgId, "admin"), { kind: "reorderObjects", objectIds: args.objectIds }); } });
export const setArchived = mutation({ args: { orgId: v.id("orgs"), objectId: v.id("objects"), archived: v.boolean() }, handler: async (ctx, args) => { await applyLifecycle(ctx, await requireWriter(ctx, args.orgId, "admin"), { kind: args.archived ? "archiveObject" : "unarchiveObject", objectId: args.objectId }); } });
export const setTitleField = mutation({ args: { orgId: v.id("orgs"), objectId: v.id("objects"), fieldId: v.id("fields") }, handler: async (ctx, args) => { await applyLifecycle(ctx, await requireWriter(ctx, args.orgId, "admin"), { kind: "setTitleField", objectId: args.objectId, fieldId: args.fieldId }); } });
// What retiring a field (or, without one, archiving the object) would touch, before a person confirms.
export const impact = query({ args: { orgId: v.id("orgs"), objectId: v.id("objects"), fieldId: v.optional(v.id("fields")) }, handler: async (ctx, args) => {
  const principal = await requireMember(ctx, args.orgId, "admin"), object = await ctx.db.get(args.objectId);
  if (!object || object.orgId !== args.orgId) fail("NOT_FOUND", "Object not found");
  await requireObjectAdministration(ctx, principal, object);
  return impactOf(ctx, principal, args.fieldId ? { kind: "retireField", objectId: object._id, fieldId: args.fieldId } : { kind: "archiveObject", objectId: object._id });
} });
