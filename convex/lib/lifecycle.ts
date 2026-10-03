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
  opportunity: { stage: "Today's quiet deals and agent guards need it" },
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
        // Every field whose values stored titles may still hold, until a full pass ends; a pass restarts from the top.
        const from = [...new Set([...(object.retitling?.from ?? []), ...(object.titleFieldId ? [object.titleFieldId] : [])])].filter((id) => id !== field._id);
        await m.db.patch(object._id, { titleFieldId: field._id, retitling: { from, cursor: null, at: Date.now() } });
        await retitlePage(m, object._id);
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

// Stored record titles feed the search index and title matching. After the title field
// changes they still hold earlier fields' values until rewritten, so the object carries
// `retitling` (those fields and a cursor) until the last page is done, and search and
// title matching treat it as unsafe for anyone who cannot read every one of them
// (lib/search.ts). The first page is rewritten with the change, the rest in scheduled
// pages; a page that stops is picked up by resumeRetitles (minute cron) in smaller pages.
const RETITLED = 50, RESUMED = 10, STALLED = 2 * 60_000;
const retitleRef = makeFunctionReference<"mutation", { objectId: Id<"objects"> }>("lib/lifecycle:retitle");
async function retitlePage(ctx: MutationCtx, objectId: Id<"objects">, size = RETITLED) {
  const object = await ctx.db.get(objectId);
  if (!object?.retitling) return;
  const field = object.titleFieldId ? await ctx.db.get(object.titleFieldId) : null;
  // Lookup titles are copied from the target by applyChange; nothing to rewrite here.
  if (field?.type !== "text") return ctx.db.patch(object._id, { retitling: undefined });
  const page = await ctx.db.query("records").withIndex("by_object", (q) => q.eq("orgId", object.orgId).eq("objectId", object._id)).paginate({ cursor: object.retitling.cursor, numItems: size });
  for (const record of page.page) { const value = record.values[field._id], title = value == null ? "" : String(value); if (record.title !== title) await ctx.db.patch(record._id, { title }); }
  if (page.isDone) return ctx.db.patch(object._id, { retitling: undefined });
  await ctx.db.patch(object._id, { retitling: { ...object.retitling, cursor: page.continueCursor, at: Date.now() } });
  await ctx.scheduler.runAfter(0, retitleRef, { objectId: object._id });
}
export const retitle = internalMutation({ args: { objectId: v.id("objects") }, handler: (ctx, args) => retitlePage(ctx, args.objectId) });
export const resumeRetitles = internalMutation({ args: {}, handler: async (ctx) => {
  for (const object of await ctx.db.query("objects").withIndex("by_retitling", (q) => q.gte("retitling.at", 0).lt("retitling.at", Date.now() - STALLED)).take(20)) await retitlePage(ctx, object._id, RESUMED);
} });

// What retiring a field or archiving an object touches, for the person deciding. Each
// preview is its own query and stops counting at 500 records or a few megabytes read.
const COUNTED = 500, BYTES = 3_000_000;
const held = (value: unknown) => value != null && value !== "" && !(Array.isArray(value) && !value.length);
// Reads in index order until 500 records or about 3 MB; past either the count reads "500+" or "N+".
async function upTo(query: AsyncIterable<Doc<"records">>) {
  const rows: Doc<"records">[] = [];
  let bytes = 0, more = false;
  for await (const row of query) { if (rows.length === COUNTED || bytes > BYTES) { more = true; break; } rows.push(row); bytes += JSON.stringify(row).length; }
  return { rows, text: `${rows.length.toLocaleString("en-US")}${more ? "+" : ""}`, one: !more && rows.length === 1 };
}
// Only what the person may read is named: a hidden target or linking field is left out.
export async function impactOf(ctx: Ctx, principal: Principal, change: ShapeChange): Promise<string[]> {
  if (change.kind !== "retireField" && change.kind !== "archiveObject") return [];
  const object = await ctx.db.get(change.objectId);
  if (!object) return [];
  const records = () => ctx.db.query("records").withIndex("by_object", (q) => q.eq("orgId", object.orgId).eq("objectId", object._id));
  if (change.kind === "retireField") {
    const field = await ctx.db.get(change.fieldId);
    if (!field || field.objectId !== object._id) return [];
    const linked = field.targetObjectId ? await ctx.db.get(field.targetObjectId) : null, target = linked && canReadObject(principal, linked) ? linked : null;
    // An indexed field is counted through its slot, reading only records that hold a value.
    const slot = field.slot && `${field.slot.kind}${field.slot.index}`, empty = field.slot?.kind === "s" ? "" : null;
    const all = await upTo(records());
    const holding = slot ? await upTo(ctx.db.query("records").withIndex(`by_${slot}` as "by_s0", (q) => q.eq("orgId", object.orgId).eq("objectId", object._id).gt(slot as "s0", empty as string))) : null;
    const count = holding ? holding.text : `${all.rows.filter((r) => held(r.values[field._id])).length.toLocaleString("en-US")}${all.text.endsWith("+") ? "+" : ""}`;
    return [
      `${count} ${count === "1" ? "record" : "records"} of ${all.text} hold a value. Values are kept and come back if you restore it.`,
      ...(field.type === "lookup" || field.type === "links" ? [`Its links stop showing on ${target ? target.labelPlural : "related records"} until it is restored.`] : []),
      "People, agents, imports and exports stop seeing it.",
    ];
  }
  const all = await upTo(records()), inbound = [];
  for (const other of await objectsOf(ctx, object.orgId)) if (other._id !== object._id && canReadObject(principal, other)) for (const field of await fieldsOf(ctx, object.orgId, other._id)) if (!field.retired && field.targetObjectId === object._id && canReadField(principal, other, field)) inbound.push(`${other.label}: ${field.label}`);
  return [
    `${all.text} ${all.one ? "record" : "records"} kept. Links to them keep working.`,
    ...(inbound.length ? [`Linked from ${inbound.join(", ")}.`] : []),
    "Hidden from navigation, search and the agents' object list until you unarchive it.",
  ];
}
