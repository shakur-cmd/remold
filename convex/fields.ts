import { mutation, query, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { requireWriter, requireMember } from "./identity";
import { fail } from "./errors";
import { canReadField, requireObjectRead } from "./authority/reads";
import { checkOptions, createField, fieldFor, fieldSpec, option, type Lifecycle } from "./lib/metadata";
import { applyLifecycle } from "./lib/lifecycle";

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
// Lifecycle changes share their rules with agents' proposals (lib/lifecycle.ts).
async function lifecycle(ctx: MutationCtx, orgId: Id<"orgs">, fieldId: Id<"fields">, change: (field: Doc<"fields">) => Lifecycle) {
  const principal = await requireWriter(ctx, orgId, "admin"), field = await ctx.db.get(fieldId);
  if (!field || field.orgId !== orgId) fail("NOT_FOUND", "Field not found");
  await applyLifecycle(ctx, principal, change(field));
}
export const retire = mutation({ args: { orgId: v.id("orgs"), fieldId: v.id("fields") }, handler: (ctx, args) => lifecycle(ctx, args.orgId, args.fieldId, (f) => ({ kind: "retireField", objectId: f.objectId, fieldId: f._id })) });
export const restore = mutation({ args: { orgId: v.id("orgs"), fieldId: v.id("fields") }, handler: (ctx, args) => lifecycle(ctx, args.orgId, args.fieldId, (f) => ({ kind: "restoreField", objectId: f.objectId, fieldId: f._id })) });
export const reorderOptions = mutation({ args: { orgId: v.id("orgs"), fieldId: v.id("fields"), optionIds: v.array(v.string()) }, handler: (ctx, args) => lifecycle(ctx, args.orgId, args.fieldId, (f) => ({ kind: "reorderOptions", objectId: f.objectId, fieldId: f._id, optionIds: args.optionIds })) });
export const reorder = mutation({ args: { orgId: v.id("orgs"), objectId: v.id("objects"), fieldIds: v.array(v.id("fields")) }, handler: async (ctx, args) => { await applyLifecycle(ctx, await requireWriter(ctx, args.orgId, "admin"), { kind: "reorderFields", objectId: args.objectId, fieldIds: args.fieldIds }); } });
