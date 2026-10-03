import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireWriter, requireMember } from "./identity";
import { fail } from "./errors";
import { canReadObject, canReadField, requireObjectRead } from "./authority/reads";
import { createObject, objectSpec } from "./lib/metadata";

export const list = query({ args: { orgId: v.id("orgs") }, handler: async (ctx, args) => { const principal = await requireMember(ctx, args.orgId); const rows = await ctx.db.query("objects").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).collect(); return rows.filter(o => canReadObject(principal, o)).sort((a, b) => a.order - b.order); } });
export const get = query({ args: { orgId: v.id("orgs"), objectId: v.id("objects") }, handler: async (ctx, args) => { const principal = await requireMember(ctx, args.orgId); const object = await ctx.db.get(args.objectId); if (!object || object.orgId !== args.orgId) fail("NOT_FOUND", "Object not found"); requireObjectRead(principal, object); const rows = await ctx.db.query("fields").withIndex("by_object", (q) => q.eq("orgId", args.orgId).eq("objectId", args.objectId)).collect(); const fields = []; for (const field of rows) if (!field.retired && canReadField(principal, object, field)) fields.push(field); return { object, fields: fields.sort((a, b) => a.order - b.order) }; } });
export const create = mutation({ args: { orgId: v.id("orgs"), ...objectSpec }, handler: async (ctx, { orgId, ...spec }) => (await createObject(ctx, await requireWriter(ctx, orgId, "admin"), spec)).objectId });
