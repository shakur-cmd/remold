import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireWriter, requireMember } from "./identity";
import { fail } from "./errors";
import { canReadField, requireObjectRead, requireObjectAdministration } from "./authority/reads";
import { checkOptions, createField, fieldFor, fieldSpec, option } from "./lib/metadata";

export const list = query({ args: { orgId: v.id("orgs"), objectId: v.id("objects") }, handler: async (ctx, args) => { const principal = await requireMember(ctx, args.orgId); const object = await ctx.db.get(args.objectId); if (!object || object.orgId !== args.orgId) fail("NOT_FOUND", "Object not found"); requireObjectRead(principal, object); return (await ctx.db.query("fields").withIndex("by_object", (q) => q.eq("orgId", args.orgId).eq("objectId", args.objectId)).collect()).filter(f => canReadField(principal, object, f)).sort((a, b) => a.order - b.order); } });
export const create = mutation({ args: { orgId: v.id("orgs"), objectId: v.id("objects"), ...fieldSpec.fields }, handler: async (ctx, { orgId, objectId, ...spec }) => {
  const principal = await requireWriter(ctx, orgId, "admin"), object = await ctx.db.get(objectId);
  if (!object || object.orgId !== orgId) fail("NOT_FOUND", "Object not found");
  return createField(ctx, principal, object, spec);
} });
export const update = mutation({ args: { orgId: v.id("orgs"), fieldId: v.id("fields"), label: v.optional(v.string()), options: v.optional(v.array(option)), protectedFromAgents: v.optional(v.boolean()) }, handler: async (ctx, args) => {
  const { field } = await fieldFor(ctx, await requireWriter(ctx, args.orgId, "admin"), args.fieldId);
  if (args.options) checkOptions(field, args.options);
  await ctx.db.patch(args.fieldId, { ...(args.label === undefined ? {} : { label: args.label }), ...(args.options === undefined ? {} : { options: args.options }), ...(args.protectedFromAgents === undefined ? {} : { protectedFromAgents: args.protectedFromAgents }) });
} });
export const retire = mutation({ args: { orgId: v.id("orgs"), fieldId: v.id("fields") }, handler: async (ctx, args) => { const principal = await requireWriter(ctx, args.orgId, "admin"); const field = await ctx.db.get(args.fieldId); if (!field || field.orgId !== args.orgId) fail("NOT_FOUND", "Field not found"); const object = await ctx.db.get(field.objectId); if (!object) fail("NOT_FOUND"); await requireObjectAdministration(ctx, principal, object); if (object.titleFieldId === field._id) fail("VALIDATION", "Cannot retire title field"); if (object.isStandard && object.key === "post" && (field.key === "status" || field.key === "publishedLink")) fail("VALIDATION", `${field.label} cannot be retired: a post is published only with its published link`); if (object.isStandard && object.key === "email" && ["body", "campaign", "followsUp", "status"].includes(field.key)) fail("VALIDATION", `${field.label} cannot be retired: campaign sending needs it`); await ctx.db.patch(field._id, { retired: true }); } });
