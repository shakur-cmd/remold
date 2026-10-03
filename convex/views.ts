import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { requireMember, requireWriter, type Membership } from "./identity";
import { fail } from "./errors";
import { canReadObject } from "./authority/reads";
import { archived, checkView, effective, forReader, viewRange, viewSort, viewSpec, layout, type ViewSpec } from "./lib/views";
import { filter } from "./lib/list";

type Ctx = QueryCtx | MutationCtx;
const isAdmin = (principal: Membership) => principal.member.role !== "member";

// A person sees shared views and their own, on objects they can read. Personal views
// of others answer like ones that do not exist.
async function visible(ctx: Ctx, principal: Membership, viewId: Id<"views">) {
  const view = await ctx.db.get(viewId), object = view && view.orgId === principal.org._id ? await ctx.db.get(view.objectId) : null;
  if (!view || !object || !canReadObject(principal, object) || (view.ownerId && view.ownerId !== principal.user._id)) fail("NOT_FOUND", "View not found");
  return { view, object };
}
async function editable(ctx: Ctx, principal: Membership, viewId: Id<"views">) {
  const found = await visible(ctx, principal, viewId);
  if (!found.view.ownerId && !isAdmin(principal)) fail("FORBIDDEN", "Only an admin can change a shared view");
  return found;
}
const ordered = (a: Doc<"views">, b: Doc<"views">) => Number(!!a.ownerId) - Number(!!b.ownerId) || a.order - b.order || a._creationTime - b._creationTime;

// Shared views first, in the order admins set, then the reader's own.
export const list = query({ args: { orgId: v.id("orgs") }, handler: async (ctx, args) => {
  const principal = await requireMember(ctx, args.orgId), objects = new Map<string, Doc<"objects"> | null>();
  const rows = (await ctx.db.query("views").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).collect()).filter((view) => !view.ownerId || view.ownerId === principal.user._id).sort(ordered);
  const out = [];
  for (const view of rows) {
    if (!objects.has(view.objectId)) objects.set(view.objectId, await ctx.db.get(view.objectId));
    const object = objects.get(view.objectId);
    if (!object || archived(object) || !canReadObject(principal, object)) continue;
    const { spec, blocked, dropped, createdBy } = await forReader(ctx, principal, object, view);
    out.push({ _id: view._id, objectId: view.objectId, ...spec, shared: !view.ownerId, pinned: !!view.pinned, editable: !!view.ownerId || isAdmin(principal), createdBy, blocked, dropped });
  }
  return out;
} });

// A view is personal unless shared; only admins share, and only shared views can be pinned in the menu.
export async function insertView(ctx: MutationCtx, principal: Membership, object: Doc<"objects">, spec: ViewSpec, options: { shared: boolean; pinned?: boolean; createdBy: Doc<"views">["createdBy"] }) {
  if (options.shared && !isAdmin(principal)) fail("FORBIDDEN", "Only an admin can share a view");
  if (options.pinned && !options.shared) fail("VALIDATION", "Only a shared view can be pinned");
  const checked = await checkView(ctx, principal, object, spec);
  const ownerId = options.shared ? undefined : principal.user._id;
  const last = (await ctx.db.query("views").withIndex("by_object", (q) => q.eq("orgId", object.orgId).eq("objectId", object._id)).collect()).filter((view) => view.ownerId === ownerId).reduce((max, view) => Math.max(max, view.order), -1);
  return ctx.db.insert("views", { orgId: object.orgId, objectId: object._id, ...checked, name: checked.name.trim(), ...(ownerId ? { ownerId } : {}), ...(options.pinned ? { pinned: true } : {}), order: last + 1, createdBy: options.createdBy, updatedAt: Date.now() });
}

export const create = mutation({ args: { orgId: v.id("orgs"), objectId: v.id("objects"), ...viewSpec, shared: v.optional(v.boolean()), pinned: v.optional(v.boolean()) }, handler: async (ctx, { orgId, objectId, shared, pinned, ...spec }) => {
  const principal = await requireWriter(ctx, orgId), object = await ctx.db.get(objectId);
  if (!object || object.orgId !== orgId || !canReadObject(principal, object)) fail("NOT_FOUND", "Object not found");
  return insertView(ctx, principal, object, spec, { shared: !!shared, pinned, createdBy: principal.actor });
} });

// Replaces the parts given; null clears an optional part. The result is checked as a
// whole, after leaving out retired fields, so saving a view also cleans it.
export const update = mutation({ args: { orgId: v.id("orgs"), viewId: v.id("views"), name: v.optional(v.string()), layout: v.optional(layout), columns: v.optional(v.array(v.id("fields"))), filters: v.optional(v.array(filter)), range: v.optional(v.union(viewRange, v.null())), sort: v.optional(v.union(viewSort, v.null())), groupFieldId: v.optional(v.union(v.id("fields"), v.null())), dateFieldId: v.optional(v.union(v.id("fields"), v.null())), pinned: v.optional(v.boolean()) }, handler: async (ctx, { orgId, viewId, pinned, ...patch }) => {
  const principal = await requireWriter(ctx, orgId), { view, object } = await editable(ctx, principal, viewId);
  if (pinned && view.ownerId) fail("VALIDATION", "Only a shared view can be pinned");
  const next: Record<string, unknown> = { ...(await effective(ctx, view)).spec };
  for (const [key, value] of Object.entries(patch)) if (value !== undefined) next[key] = value ?? undefined;
  const checked = await checkView(ctx, principal, object, next as ViewSpec);
  await ctx.db.patch(view._id, { range: undefined, sort: undefined, groupFieldId: undefined, dateFieldId: undefined, ...checked, name: checked.name.trim(), ...(pinned === undefined ? {} : { pinned }), updatedAt: Date.now() });
} });

// Shared views are ordered by admins and personal ones by their owner, one object at a time.
export const reorder = mutation({ args: { orgId: v.id("orgs"), viewIds: v.array(v.id("views")) }, handler: async (ctx, args) => {
  const principal = await requireWriter(ctx, args.orgId), views = [];
  for (const id of args.viewIds) views.push((await editable(ctx, principal, id)).view);
  if (new Set(views.map((view) => `${view.objectId}:${view.ownerId ?? ""}`)).size > 1 || new Set(args.viewIds).size !== args.viewIds.length) fail("VALIDATION", "Reorder the shared or the personal views of one object at a time");
  for (const [order, view] of views.entries()) await ctx.db.patch(view._id, { order });
} });

// A reduction, so it stays available while the workspace is read only.
export const remove = mutation({ args: { orgId: v.id("orgs"), viewId: v.id("views") }, handler: async (ctx, args) => {
  const principal = await requireMember(ctx, args.orgId), { view } = await editable(ctx, principal, args.viewId);
  await ctx.db.delete(view._id);
} });
