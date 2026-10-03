import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx, type QueryCtx } from "../_generated/server";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import type { Membership, Principal } from "../identity";
import { fail } from "../errors";
import { canReadField, canReadObject, requireObjectAdministration } from "../authority/reads";
import { fieldFor, fieldsOf, requireUnrestricted, type Lifecycle, type ShapeChange } from "./metadata";

// Retire, restore, reorder, archive and retitle: the checks and writes shared by a
// person's Settings mutations and by applying an agent's proposal. Nothing is deleted
// and every change has an inverse, recorded in authorityAudit with what it replaced.
type Ctx = QueryCtx | MutationCtx;

// Standard fields a feature reads by key: retiring one would quietly switch it off.
const sending = "campaign sending needs it", timelines = "record timelines need it", today = "Today needs it", invoices = "invoice tracking needs it", published = "a post is published only with its published link";
const relied: Record<string, Record<string, string>> = {
  post: { status: published, publishedLink: published, planned: "the post calendar needs it" },
  // Subject is Email's title, but the title can move to another field.
  email: { subject: sending, body: sending, campaign: sending, followsUp: sending, status: sending },
  person: { email: sending },
  campaign: { people: sending, status: sending },
  note: { about: "email replies are saved as notes about a person" },
  activity: { about: timelines, when: timelines, type: timelines },
  task: { dueDate: today, done: today },
  invoice: { amount: invoices, due: invoices, paidOn: invoices },
};

const byOrder = <T extends { order: number }>(a: T, b: T) => a.order - b.order;
const sameSet = <T>(list: T[], all: T[]) => list.length === all.length && new Set(list).size === list.length && list.every((item) => all.includes(item));
async function renumber<T extends "fields" | "objects">(ctx: MutationCtx, docs: Doc<T>[], next: Id<T>[]) {
  const before = new Map(docs.map((doc) => [doc._id as string, doc.order]));
  for (const [order, id] of next.entries()) if (before.get(id) !== order) await ctx.db.patch(id as Id<"fields">, { order });
}
async function fieldOn(ctx: Ctx, principal: Principal, objectId: Id<"objects">, fieldId: Id<"fields">) {
  const found = await fieldFor(ctx, principal, fieldId);
  if (found.object._id !== objectId) fail("NOT_FOUND", "Field not found");
  return found;
}
async function objectFor(ctx: Ctx, principal: Principal, objectId: Id<"objects">) {
  const object = await ctx.db.get(objectId);
  if (!object || object.orgId !== principal.org._id) fail("NOT_FOUND", "Object not found");
  await requireObjectAdministration(ctx, principal, object);
  return object;
}
const objectsOf = async (ctx: Ctx, orgId: Id<"orgs">) => (await ctx.db.query("objects").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()).sort(byOrder);

type Checked = { target: string; objectIds: Id<"objects">[]; fieldIds: Id<"fields">[]; write: (ctx: MutationCtx) => Promise<string | void> };
// Everything is checked before the returned write runs, so a refusal leaves nothing behind.
export async function checkLifecycle(ctx: Ctx, principal: Principal, change: Lifecycle): Promise<Checked> {
  const orgId = principal.org._id;
  switch (change.kind) {
    case "retireField": {
      const { field, object } = await fieldOn(ctx, principal, change.objectId, change.fieldId);
      if (field.retired) fail("VALIDATION", "Field is already retired");
      if (object.titleFieldId === field._id) fail("VALIDATION", "Cannot retire title field");
      const reason = object.isStandard ? relied[object.key]?.[field.key] : undefined;
      if (reason) fail("VALIDATION", `${field.label} cannot be retired: ${reason}`);
      return { target: field._id, objectIds: [object._id], fieldIds: [field._id], write: (m) => m.db.patch(field._id, { retired: true }) };
    }
    case "restoreField": {
      const { field, object } = await fieldOn(ctx, principal, change.objectId, change.fieldId);
      if (!field.retired) fail("VALIDATION", "Field is not retired");
      // A retired field keeps its slot, so normally nothing else can hold it. Only a
      // migration that released slots (lib/slots releaseSlot) could have let one go.
      const slot = field.slot, holder = slot && (await fieldsOf(ctx, orgId, object._id)).find((f) => f._id !== field._id && f.slot?.kind === slot.kind && f.slot.index === slot.index);
      if (holder) fail("SLOTS_EXHAUSTED", `${field.label} cannot be restored: its index slot is now used by ${holder.label}`);
      if (!slot && field.type === "lookup") fail("SLOTS_EXHAUSTED", `${field.label} cannot be restored: a lookup needs an index slot and it has none`);
      return { target: field._id, objectIds: [object._id], fieldIds: [field._id], write: (m) => m.db.patch(field._id, { retired: false }) };
    }
    case "reorderFields": {
      const object = await objectFor(ctx, principal, change.objectId), all = (await fieldsOf(ctx, orgId, object._id)).sort(byOrder), live = all.filter((f) => !f.retired);
      if (!sameSet(change.fieldIds, live.map((f) => f._id))) fail("VALIDATION", "List every field of the object once");
      // Retired fields keep their relative order after the live ones.
      return { target: object._id, objectIds: [object._id], fieldIds: change.fieldIds, write: async (m) => { await renumber(m, all, [...change.fieldIds, ...all.filter((f) => f.retired).map((f) => f._id)]); return live.map((f) => f.key).join(","); } };
    }
    case "reorderObjects": {
      await requireUnrestricted(ctx, principal);
      const all = await objectsOf(ctx, orgId), shown = all.filter((o) => !o.archived);
      if (!sameSet(change.objectIds, shown.map((o) => o._id))) fail("VALIDATION", "List every object once");
      return { target: orgId, objectIds: change.objectIds, fieldIds: [], write: async (m) => { await renumber(m, all, [...change.objectIds, ...all.filter((o) => o.archived).map((o) => o._id)]); return shown.map((o) => o.key).join(","); } };
    }
    case "reorderOptions": {
      const { field, object } = await fieldOn(ctx, principal, change.objectId, change.fieldId), options = field.options ?? [];
      if (field.retired) fail("VALIDATION", "Field was retired");
      if (field.type !== "select") fail("VALIDATION", "Only select fields have options");
      if (!sameSet(change.optionIds, options.map((o) => o.id))) fail("VALIDATION", "List every option once");
      return { target: field._id, objectIds: [object._id], fieldIds: [field._id], write: async (m) => { await m.db.patch(field._id, { options: change.optionIds.map((id) => options.find((o) => o.id === id)!) }); return options.map((o) => o.id).join(","); } };
    }
    case "archiveObject": case "unarchiveObject": {
      const object = await objectFor(ctx, principal, change.objectId), archive = change.kind === "archiveObject";
      if (archive && object.isStandard) fail("VALIDATION", "Standard objects cannot be archived");
      if (archive === !!object.archived) fail("VALIDATION", archive ? "Object is already archived" : "Object is not archived");
      return { target: object._id, objectIds: [object._id], fieldIds: [], write: (m) => m.db.patch(object._id, { archived: archive }) };
    }
    case "setTitleField": {
      const { field, object } = await fieldOn(ctx, principal, change.objectId, change.fieldId);
      if (field.retired) fail("VALIDATION", "Field was retired");
      if (field.type !== "text") fail("VALIDATION", "Only a text field can be the title");
      if (object.titleFieldId === field._id) fail("VALIDATION", "This is already the title field");
      return { target: field._id, objectIds: [object._id], fieldIds: [field._id], write: async (m) => {
        await m.db.patch(object._id, { titleFieldId: field._id });
        await retitlePage(m, object._id, null);
        return object.titleFieldId ? (await m.db.get(object.titleFieldId))?.key : undefined;
      } };
    }
  }
}

export async function applyLifecycle(ctx: MutationCtx, principal: Membership, change: Lifecycle) {
  const { target, objectIds, fieldIds, write } = await checkLifecycle(ctx, principal, change), before = await write(ctx);
  await ctx.db.insert("authorityAudit", { orgId: principal.org._id, actor: principal.actor, action: change.kind, targetId: target, objectIds, ...(before ? { before } : {}) });
  return { objectIds, fieldIds };
}

// Stored record titles (the search index) follow the title field: the first page is
// rewritten with the change, the rest in later transactions. Each page reads the current
// title field, so a later change simply wins. Readers never see a stale title: visibleTitle
// reads the title field's value. Safe to re-run by hand with cursor null.
const RETITLED = 50;
const retitleRef = makeFunctionReference<"mutation", { objectId: Id<"objects">; cursor: string | null }>("lib/lifecycle:retitle");
async function retitlePage(ctx: MutationCtx, objectId: Id<"objects">, cursor: string | null) {
  const object = await ctx.db.get(objectId), field = object?.titleFieldId ? await ctx.db.get(object.titleFieldId) : null;
  if (!object || field?.type !== "text") return;
  const page = await ctx.db.query("records").withIndex("by_object", (q) => q.eq("orgId", object.orgId).eq("objectId", object._id)).paginate({ cursor, numItems: RETITLED });
  for (const record of page.page) { const value = record.values[field._id], title = value == null ? "" : String(value); if (record.title !== title) await ctx.db.patch(record._id, { title }); }
  if (!page.isDone) await ctx.scheduler.runAfter(0, retitleRef, { objectId: object._id, cursor: page.continueCursor });
}
export const retitle = internalMutation({ args: { objectId: v.id("objects"), cursor: v.union(v.string(), v.null()) }, handler: (ctx, args) => retitlePage(ctx, args.objectId, args.cursor) });

// What retiring a field or archiving an object touches, for the person deciding.
const plural = (n: number, word: string) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
// Each preview is its own query; it reads a bounded number of records.
const COUNTED = 500;
const held = (value: unknown) => value != null && value !== "" && !(Array.isArray(value) && !value.length);
// Only what the person may read is named: a hidden target or linking field is left out.
export async function impactOf(ctx: Ctx, principal: Principal, change: ShapeChange): Promise<string[]> {
  if (change.kind !== "retireField" && change.kind !== "archiveObject") return [];
  const object = await ctx.db.get(change.objectId);
  if (!object) return [];
  const read = await ctx.db.query("records").withIndex("by_object", (q) => q.eq("orgId", object.orgId).eq("objectId", object._id)).take(COUNTED + 1);
  const records = read.slice(0, COUNTED), more = read.length > COUNTED;
  if (change.kind === "retireField") {
    const field = await ctx.db.get(change.fieldId);
    if (!field || field.objectId !== object._id) return [];
    const count = records.filter((r) => held(r.values[field._id])).length, linked = field.targetObjectId ? await ctx.db.get(field.targetObjectId) : null, target = linked && canReadObject(principal, linked) ? linked : null;
    return [
      `${more ? `${count.toLocaleString("en-US")} of the first ${plural(COUNTED, "record")}` : `${plural(count, "record")} of ${records.length}`} hold a value. Values are kept and come back if you restore it.`,
      ...(field.type === "lookup" || field.type === "links" ? [`Its links stop showing on ${target ? target.labelPlural : "related records"} until it is restored.`] : []),
      "People, agents, imports and exports stop seeing it.",
    ];
  }
  const inbound = [];
  for (const other of await objectsOf(ctx, object.orgId)) if (other._id !== object._id && canReadObject(principal, other)) for (const field of await fieldsOf(ctx, object.orgId, other._id)) if (!field.retired && field.targetObjectId === object._id && canReadField(principal, other, field)) inbound.push(`${other.label}: ${field.label}`);
  return [
    `${more ? `More than ${plural(COUNTED, "record")}` : plural(records.length, "record")} kept. Links to them keep working.`,
    ...(inbound.length ? [`Linked from ${inbound.join(", ")}.`] : []),
    "Hidden from navigation, search and the agents' object list until you unarchive it.",
  ];
}
