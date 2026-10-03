import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { ConvexError } from "convex/values";
import type { Actor, Membership, Principal } from "../identity";
import { fail } from "../errors";
import { canReadField, canReadObject, canReadRecordId } from "../authority/reads";
import { createObject, fieldsOf, requireLabel, requireUnrestricted, validKey, type Blueprint, type FieldSpec } from "./metadata";
import { changeFor, perform, type ChangeInput } from "./proposals";
import { capacity, kindFor, type SlotKind } from "./slots";
import { resolveValues } from "./values";
import { applyChange } from "./applyChange";
import { standard } from "./standard";

// A blueprint is a whole shape change in one reviewable piece: the agent proposal kinds,
// in order, objects named by key so a new object can be referenced before it exists, plus
// opt-in starter records. Each step runs through the same checks and writes as a single
// proposal (lib/proposals.ts). Applying is one transaction: any failure throws and Convex
// discards every write, so nothing is ever half applied. The size limits keep a blueprint
// well inside one transaction's limits, so it never needs chunks.
type Ctx = QueryCtx | MutationCtx;
export type { Blueprint };
const steps = ["addObject", "addField", "addOptions", "relabel", "addView", "reorderFields", "reorderObjects", "reorderOptions", "archiveObject", "setTitleField", "retireField"];
const MAX_CHANGES = 100, MAX_OBJECTS = 20, MAX_RECORDS = 50;
const verbs: Record<string, string> = { addObject: "add object", addField: "add field", addOptions: "add options", relabel: "relabel", addView: "add view", reorderFields: "reorder fields", reorderObjects: "reorder objects", reorderOptions: "reorder options", archiveObject: "archive object", setTitleField: "set title", retireField: "retire field" };
const kindWords: Record<SlotKind, string> = { s: "text", n: "number", d: "date", b: "boolean" };
const byOrder = <T extends { order: number }>(a: T, b: T) => a.order - b.order;
const plural = (n: number, word: string, words = `${word}s`) => `${n} ${n === 1 ? word : words}`;

// A blueprint can touch any object and resolves starter-record links by title, so its
// proposer must see every object, field and record. People without read limits already do.
export async function requireWholeWorkspace(ctx: Ctx, principal: Principal) {
  await requireUnrestricted(ctx, principal);
  for (const object of await ctx.db.query("objects").withIndex("by_org", (q) => q.eq("orgId", principal.org._id)).collect()) if (!canReadRecordId(principal, object)) fail("FORBIDDEN", "A blueprint needs access to every object, field and record");
}

export function parseBlueprint(blueprint: Blueprint) {
  if (blueprint.version !== 1) fail("VALIDATION", "Unsupported blueprint version; use 1");
  requireLabel(blueprint.name, "Blueprint name");
  if (blueprint.changes.length > MAX_CHANGES) fail("VALIDATION", `A blueprint can have at most ${MAX_CHANGES} changes`);
  if (blueprint.changes.filter((c) => c.kind === "addObject").length > MAX_OBJECTS) fail("VALIDATION", `A blueprint can add at most ${MAX_OBJECTS} objects`);
  if ((blueprint.records?.length ?? 0) > MAX_RECORDS) fail("VALIDATION", `A blueprint can carry at most ${MAX_RECORDS} starter records`);
  blueprint.changes.forEach((change, i) => { if (!steps.includes(change.kind)) fail("VALIDATION", `Step ${i + 1}: kind must be one of ${steps.join(", ")}`); });
  // Values are stored with the proposal, and stored keys must be plain names.
  blueprint.records?.forEach((record, i) => { if (Object.keys(record.values).some((key) => !validKey(key))) fail("VALIDATION", `Starter record ${i + 1}: values are named by field key, like dueDate`); });
  return blueprint;
}

const stepName = (change: ChangeInput, i: number) => {
  const target = change.kind === "addObject" ? change.key : change.kind === "addView" ? `${change.object} "${change.name ?? ""}"` : change.kind === "addField" ? `${change.object}.${change.key}` : change.field ? `${change.object}.${change.field}` : change.object;
  return `Step ${i + 1}, ${verbs[change.kind]}${target ? ` ${target}` : ""}`;
};
// Says which step a shared check refused, keeping its code (and so its HTTP status).
async function within<T>(name: string, run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) {
    const data = error instanceof ConvexError ? error.data as { code?: string; message?: string } : null;
    if (data?.code && data.message) throw new ConvexError({ ...data, message: `${name}: ${data.message}` });
    throw error;
  }
}
async function readableKeys(ctx: Ctx, principal: Principal) {
  return new Map((await ctx.db.query("objects").withIndex("by_org", (q) => q.eq("orgId", principal.org._id)).collect()).filter((o) => canReadObject(principal, o)).map((o) => [o.key, o]));
}
// Every object a step or record names must exist (and be readable) or be added by the blueprint.
function checkReferences(blueprint: Blueprint, known: (key: string) => boolean) {
  blueprint.changes.forEach((change, i) => {
    for (const key of [change.kind === "addObject" || change.kind === "reorderObjects" ? undefined : change.object, change.target, ...(change.fields ?? []).map((f) => f.target)]) if (key !== undefined && !known(key)) fail("NOT_FOUND", `Step ${i + 1} refers to object "${key}", which is not in this workspace or this blueprint`);
  });
  blueprint.records?.forEach((record, i) => { if (!known(record.object)) fail("NOT_FOUND", `Starter record ${i + 1} refers to object "${record.object}", which is not in this workspace or this blueprint`); });
}

export type Applied = { objectIds: Id<"objects">[]; slots: { object: string; text: string; number: string; date: string; boolean: string }[]; records: number };
// person saves the shared views and, if records is set, the starter records: the person applying it.
// An agent's trial uses the workspace owner in their place, since agents need grants to create
// records and only a person may share a view. createdBy is credited with the views.
type Run = { person: Membership; records: boolean; createdBy?: Actor };
export async function runBlueprint(ctx: MutationCtx, proposer: Principal, blueprint: Blueprint, { person, records: withRecords, createdBy }: Run): Promise<Applied> {
  let principal = proposer;
  parseBlueprint(blueprint);
  await requireWholeWorkspace(ctx, principal);
  const existing = await readableKeys(ctx, principal), planned = new Set(blueprint.changes.flatMap((c) => c.kind === "addObject" && c.key ? [c.key] : []));
  checkReferences(blueprint, (key) => existing.has(key) || planned.has(key));
  // New objects first, with only their Name field, so any step can point a relation at any of them.
  const created: Id<"objects">[] = [];
  for (const [i, change] of blueprint.changes.entries()) if (change.kind === "addObject") await within(stepName(change, i), async () => {
    if (!change.key || !change.label || !change.labelPlural) fail("VALIDATION", "key, label and labelPlural are required");
    if ((change.fields?.length ?? 0) > 12) fail("VALIDATION", "A new object can start with at most 12 fields");
    const { objectId } = await createObject(ctx, principal, { key: change.key, label: change.label, labelPlural: change.labelPlural, ...(change.icon === undefined ? {} : { icon: change.icon }) });
    created.push(objectId);
    // An agent's trial sees the objects it adds, as it will once a person applies them (shapeSuggestions.apply).
    if ("agent" in principal && principal.agent.authorityVersion === 1) { const readObjectIds = [...(principal.agent.readObjectIds ?? []), objectId]; await ctx.db.patch(principal.agent._id, { readObjectIds }); principal = { ...principal, agent: { ...principal.agent, readObjectIds } }; }
  });
  const added: { objectId: Id<"objects">; fieldId: Id<"fields">; kind?: SlotKind }[] = [];
  const run = async (input: ChangeInput) => {
    const change = await changeFor(ctx, principal, input);
    if (change.kind === "blueprint") fail("VALIDATION", "A blueprint cannot contain a blueprint");
    const result = await perform(ctx, change.kind === "addView" ? person : principal, change, createdBy);
    if (change.kind === "addField") added.push({ objectId: change.objectId, fieldId: result.fieldIds[0]!, kind: wantsSlot(change.field) });
  };
  // Views last, so a view can use any field the blueprint adds, wherever it is listed.
  const ordered = [...blueprint.changes.entries()].sort(([, a], [, b]) => Number(a.kind === "addView") - Number(b.kind === "addView"));
  for (const [i, change] of ordered) {
    if (change.kind === "addObject") { for (const field of change.fields ?? []) await within(`${stepName(change, i)}: ${field.label}`, () => run({ ...field, kind: "addField", object: change.key })); continue; }
    await within(stepName(change, i), async () => {
      if (change.kind !== "addOptions") return run(change);
      // In a blueprint, options lists only what to add: existing options are kept as they are.
      const object = (await readableKeys(ctx, principal)).get(change.object ?? ""), field = object && await ctx.db.query("fields").withIndex("by_object_key", (q) => q.eq("orgId", object.orgId).eq("objectId", object._id).eq("key", change.field ?? "")).unique();
      const listed = change.options ?? [], kept = (field?.options ?? []).map((old) => listed.find((o) => o.id === old.id) ?? old);
      return run({ ...change, options: [...kept, ...listed.filter((o) => !kept.some((k) => k.id === o.id))] });
    });
  }
  // A single new field without a slot is kept unindexed; a blueprint says so up front instead.
  const touched = [...new Set([...created, ...added.map((a) => a.objectId)])], slots: Applied["slots"] = [];
  for (const objectId of touched) {
    const object = (await ctx.db.get(objectId))!, fields = await fieldsOf(ctx, object.orgId, objectId), used = { n: 0, s: 0, d: 0, b: 0 };
    for (const field of fields) if (field.slot) used[field.slot.kind] += 1;
    for (const kind of ["s", "n", "d", "b"] as const) {
      const missing = added.filter((a) => a.objectId === objectId && a.kind === kind && !fields.find((f) => f._id === a.fieldId)?.slot).length;
      if (missing) fail("SLOTS_EXHAUSTED", `Not enough index slots on ${object.label}: it needs ${used[kind] + missing} ${kindWords[kind]} slots and has ${capacity[kind]}. ${kind === "s" ? "Set indexed: false on text fields nobody sorts or filters by." : `Leave some ${kindWords[kind]} fields out.`}`);
    }
    slots.push({ object: object.label, text: `${used.s} of ${capacity.s}`, number: `${used.n} of ${capacity.n}`, date: `${used.d} of ${capacity.d}`, boolean: `${used.b} of ${capacity.b}` });
  }
  let records = 0;
  const writer = withRecords ? person : null;
  if (writer) for (const [i, record] of (blueprint.records ?? []).entries()) {
    const object = (await readableKeys(ctx, writer)).get(record.object)!, fields = (await fieldsOf(ctx, object.orgId, object._id)).filter((f) => !f.retired && canReadField(writer, object, f));
    const titleKey = fields.find((f) => f._id === object.titleFieldId)?.key;
    await within(`Starter record ${i + 1} (${object.label} ${titleKey ? String(record.values[titleKey] ?? "") : ""})`.replace(" )", ")"), async () => {
      const values = await resolveValues(ctx, writer, object, fields, record.values);
      for (const field of fields) if (field.required && (values[field._id] === null || values[field._id] === undefined)) fail("VALIDATION", `${field.label} is required`);
      await applyChange(ctx, writer, { action: "create", orgId: object.orgId, objectId: object._id, values, reason: `Starter record from blueprint ${blueprint.name}` });
    });
    records += 1;
  }
  return { objectIds: created, slots, records };
}
const wantsSlot = (field: FieldSpec) => field.indexed === false ? undefined : kindFor(field.type);

// A trial run applies the blueprint for real and then throws, so Convex discards every
// write. Checking a blueprint therefore runs exactly the code that applying it runs.
const TRIAL = "BLUEPRINT_TRIAL";
export function rollBack(result: Applied): never { throw new ConvexError({ code: TRIAL, message: "Checked; nothing was changed", result }); }
export async function trialOf(run: () => Promise<unknown>): Promise<Applied> {
  try { await run(); }
  catch (error) { const data = (error as { data?: { code?: string; result?: Applied } })?.data; if (data?.code === TRIAL) return data.result!; throw error; }
  throw new Error("A blueprint trial must roll back");
}
// Refusals a person can act on; anything else (a lost role, a frozen workspace) is thrown as it is.
export const refusal = (error: unknown) => { const data = (error as { data?: { code?: string; message?: string } })?.data; return data?.code && ["VALIDATION", "NOT_FOUND", "SLOTS_EXHAUSTED"].includes(data.code) ? String(data.message) : null; };

// One card: changes grouped by object, in plain words.
type Group = { key: string; title: string; lines: string[] };
export type Diff = { name: string; description: string; groups: Group[]; records: string | null; impacts: { objectId: Id<"objects">; fieldId?: Id<"fields">; label: string }[] };
export async function diffOf(ctx: Ctx, principal: Principal, blueprint: Blueprint): Promise<Diff> {
  const existing = await readableKeys(ctx, principal), news = new Map(blueprint.changes.flatMap((c) => c.kind === "addObject" && c.key ? [[c.key, c] as const] : []));
  const fieldCache = new Map<string, Doc<"fields">[]>();
  const fieldsByKey = async (key: string | undefined) => { const object = key ? existing.get(key) : undefined; if (!object) return []; if (!fieldCache.has(key!)) fieldCache.set(key!, await fieldsOf(ctx, object.orgId, object._id)); return fieldCache.get(key!)!; };
  const objectLabel = (key: string | undefined, many = false) => { const known = key ? existing.get(key) ?? news.get(key) : undefined; return known ? (many ? known.labelPlural : known.label) ?? key! : key ?? "an object"; };
  const newField = (key: string | undefined, field: string | undefined) => [...(news.get(key ?? "")?.fields ?? []), ...blueprint.changes.filter((c) => c.kind === "addField" && c.object === key)].find((f) => f.key === field);
  const fieldLabel = async (key: string | undefined, field: string | undefined) => (await fieldsByKey(key)).find((f) => f.key === field)?.label ?? newField(key, field)?.label ?? field ?? "a field";
  const describeField = (f: { label?: string; type?: string; target?: string; options?: { label: string }[]; required?: boolean; withTime?: boolean; indexed?: boolean }) => `${f.label} (${f.type}${f.target ? ` to ${objectLabel(f.target)}` : ""})${f.options ? `: ${f.options.map((o) => o.label).join(", ")}` : ""}${f.required ? ", required" : ""}${f.withTime ? ", with time" : ""}${f.indexed === false ? ", not searchable or sortable" : ""}`;
  const groups: Group[] = [], impacts: Diff["impacts"] = [];
  const group = (key: string) => { let found = groups.find((g) => g.key === key); if (!found) groups.push(found = { key, title: key === "" ? "Navigation" : news.has(key) ? "" : objectLabel(key), lines: [] }); return found; };
  for (const change of blueprint.changes) {
    const at = group(change.kind === "addObject" ? change.key ?? "" : change.kind === "reorderObjects" ? "" : change.object ?? "");
    switch (change.kind) {
      case "addObject": at.lines.push(...(change.fields ?? []).map(describeField)); break;
      case "addField": at.lines.push(news.has(change.object ?? "") ? describeField(change) : `New field ${describeField(change)}`); break;
      case "addOptions": { const old = (await fieldsByKey(change.object)).find((f) => f.key === change.field)?.options ?? []; at.lines.push(`${await fieldLabel(change.object, change.field)} gains: ${(change.options ?? []).filter((o) => !old.some((x) => x.id === o.id)).map((o) => o.label).join(", ")}`); break; }
      case "relabel": at.lines.push(change.field ? `${await fieldLabel(change.object, change.field)} renamed to ${change.label}` : `Renamed to ${change.label}${change.labelPlural ? ` (plural ${change.labelPlural})` : ""}`); break;
      case "reorderFields": at.lines.push(`Fields reordered: ${(await Promise.all((change.order ?? []).map((key) => fieldLabel(change.object, key)))).join(", ")}`); break;
      case "reorderOptions": { const field = (await fieldsByKey(change.object)).find((f) => f.key === change.field), options = [...(field?.options ?? []), ...blueprint.changes.flatMap((c) => c.kind === "addOptions" && c.object === change.object && c.field === change.field ? c.options ?? [] : [])]; at.lines.push(`${await fieldLabel(change.object, change.field)} options reordered: ${(change.order ?? []).map((id) => options.find((o) => o.id === id)?.label ?? id).join(", ")}`); break; }
      case "reorderObjects": at.lines.push(`Objects reordered: ${(change.order ?? []).map((key) => objectLabel(key, true)).join(", ")}`); break;
      case "addView": {
        const by = change.layout === "board" && change.groupBy ? `, grouped by ${await fieldLabel(change.object, change.groupBy)}` : change.layout === "calendar" && change.dateField ? `, by ${await fieldLabel(change.object, change.dateField)}` : "";
        at.lines.push(`New shared ${change.layout === "board" || change.layout === "calendar" ? `${change.layout} ` : ""}view "${change.name ?? ""}"${by}${change.filters?.length ? `, filtered on ${(await Promise.all(change.filters.map((f) => fieldLabel(change.object, f.field)))).join(", ")}` : ""}${change.pinned ? ", pinned in the menu" : ""}`);
        break;
      }
      case "setTitleField": at.lines.push(`${await fieldLabel(change.object, change.field)} becomes the title`); break;
      case "retireField": case "archiveObject": {
        const label = change.kind === "retireField" ? `Retire field ${await fieldLabel(change.object, change.field)}` : `Archive ${objectLabel(change.object)}`;
        at.lines.push(label);
        const object = existing.get(change.object ?? ""), field = change.kind === "retireField" ? (await fieldsByKey(change.object)).find((f) => f.key === change.field) : undefined;
        if (object && (change.kind === "archiveObject" || field)) impacts.push({ objectId: object._id, ...(field ? { fieldId: field._id } : {}), label: `${label}${change.kind === "retireField" ? ` on ${object.label}` : ""}` });
        break;
      }
    }
  }
  for (const [key, change] of news) { const count = (change.fields?.length ?? 0) + blueprint.changes.filter((c) => c.kind === "addField" && c.object === key).length; group(key).title = `New object ${change.label}${count ? ` with ${plural(count, "field")}` : ""}`; }
  const counts = new Map<string, number>();
  for (const record of blueprint.records ?? []) counts.set(record.object, (counts.get(record.object) ?? 0) + 1);
  const records = counts.size ? `${plural(blueprint.records!.length, "starter record")}: ${[...counts].map(([key, n]) => `${n} ${objectLabel(key, n !== 1)}`).join(", ")}` : null;
  return { name: blueprint.name, description: blueprint.description ?? "", groups, records, impacts };
}
export function summaryOf(blueprint: Blueprint) {
  const objects = blueprint.changes.filter((c) => c.kind === "addObject").length, other = blueprint.changes.length - objects;
  return `Apply blueprint ${blueprint.name}: ${[objects ? plural(objects, "new object") : "", other ? plural(other, objects ? "other change" : "change") : ""].filter(Boolean).join(", ") || "no changes"}`;
}

// The workspace's shape as a blueprint that rebuilds it on a new workspace: what differs
// from the standard objects, plus every custom object. Only what the caller can read is
// included; orders are left out when part of the list is hidden, since they must be whole.
export async function exportBlueprint(ctx: Ctx, principal: Principal): Promise<Blueprint> {
  const all = (await ctx.db.query("objects").withIndex("by_org", (q) => q.eq("orgId", principal.org._id)).collect()).sort(byOrder);
  const objects = all.filter((o) => canReadObject(principal, o)), keyOf = new Map(objects.map((o) => [o._id as string, o.key]));
  const changes: ChangeInput[] = [], customs: string[] = [];
  const spec = (f: Doc<"fields">) => ({ key: f.key, label: f.label, type: f.type, ...(f.options ? { options: f.options } : {}), ...(f.targetObjectId ? { target: keyOf.get(f.targetObjectId) } : {}), ...(f.withTime ? { withTime: true } : {}), ...(f.required ? { required: true } : {}), ...(f.type === "text" && !f.slot ? { indexed: false } : {}) });
  for (const object of objects) {
    const key = object.key, def = object.isStandard ? standard.find((d) => d.key === key) : undefined;
    const fields = (await fieldsOf(ctx, object.orgId, object._id)).sort(byOrder), seen = fields.filter((f) => canReadField(principal, object, f));
    // A relation to an object the caller cannot read is left out with it.
    const shown = seen.filter((f) => !f.targetObjectId || keyOf.has(f.targetObjectId)), live = shown.filter((f) => !f.retired), whole = shown.length === fields.length;
    // Retired fields come along, retired, so they keep their key and slot and can be restored.
    const fresh = shown.filter((f) => def ? !def.fields.some((d) => d.key === f.key) : f.key !== "name");
    let plain: string[];
    if (!def) {
      customs.push(key);
      changes.push({ kind: "addObject", key, label: object.label, labelPlural: object.labelPlural, ...(object.icon ? { icon: object.icon } : {}), fields: fresh.slice(0, 12).map(spec) }, ...fresh.slice(12).map((f) => ({ kind: "addField", object: key, ...spec(f) })));
      const name = shown.find((f) => f.key === "name");
      if (name && name.label !== "Name") changes.push({ kind: "relabel", object: key, field: "name", label: name.label });
      plain = ["name", ...fresh.map((f) => f.key)];
    } else {
      if (object.label !== def.label || object.labelPlural !== def.plural) changes.push({ kind: "relabel", object: key, label: object.label, labelPlural: object.labelPlural });
      for (const f of live) {
        const base = def.fields.find((d) => d.key === f.key);
        if (!base) continue;
        if (f.label !== base.label) changes.push({ kind: "relabel", object: key, field: f.key, label: f.label });
        const extra = (f.options ?? []).filter((o) => !base.options?.some((b) => b.id === o.id));
        if (extra.length) changes.push({ kind: "addOptions", object: key, field: f.key, options: extra });
        const ids = (f.options ?? []).map((o) => o.id), order = [...(base.options ?? []).map((o) => o.id), ...extra.map((o) => o.id)];
        if (ids.join() !== order.join()) changes.push({ kind: "reorderOptions", object: key, field: f.key, order: ids });
      }
      changes.push(...fresh.map((f) => ({ kind: "addField", object: key, ...spec(f) })));
      plain = [...def.fields.map((d) => d.key), ...fresh.map((f) => f.key)];
    }
    const title = shown.find((f) => f._id === object.titleFieldId);
    if (title && title.key !== (def ? def.fields[0]!.key : "name")) changes.push({ kind: "setTitleField", object: key, field: title.key });
    for (const f of shown) if (f.retired) changes.push({ kind: "retireField", object: key, field: f.key });
    const liveKeys = live.map((f) => f.key);
    if (whole && liveKeys.join() !== plain.filter((k) => liveKeys.includes(k)).join()) changes.push({ kind: "reorderFields", object: key, order: liveKeys });
    if (object.archived && !def) changes.push({ kind: "archiveObject", object: key });
  }
  // Shared views, by key. One that filters on a relation is left out: its value names a record of this workspace.
  for (const object of objects) {
    const fields = new Map((await fieldsOf(ctx, object.orgId, object._id)).map((f) => [f._id as string, f]));
    const views = (await ctx.db.query("views").withIndex("by_object", (q) => q.eq("orgId", object.orgId).eq("objectId", object._id)).collect()).filter((view) => !view.ownerId).sort((a, b) => a.order - b.order || a._creationTime - b._creationTime);
    for (const view of views) {
      const used = [...view.columns, ...view.filters.map((f) => f.fieldId), view.range?.fieldId, view.sort?.fieldId, view.groupFieldId, view.dateFieldId].flatMap((id) => id ? [fields.get(id)] : []);
      if (used.some((f) => !f || f.retired || !canReadField(principal, object, f)) || view.filters.some((f) => ["lookup", "links"].includes(fields.get(f.fieldId)!.type))) continue;
      const key = (id: Id<"fields">) => fields.get(id)!.key, { range, sort } = view;
      changes.push({ kind: "addView", object: object.key, name: view.name, layout: view.layout, columns: view.columns.map(key), filters: view.filters.map((f) => ({ field: key(f.fieldId), value: f.value })), ...(range ? { range: { field: key(range.fieldId), ...(range.from ? { from: range.from } : {}), ...(range.to ? { to: range.to } : {}), ...(range.relative ? { relative: range.relative } : {}) } } : {}), ...(sort ? { sort: { field: key(sort.fieldId), direction: sort.direction } } : {}), ...(view.groupFieldId ? { groupBy: key(view.groupFieldId) } : {}), ...(view.dateFieldId ? { dateField: key(view.dateFieldId) } : {}), ...(view.pinned ? { pinned: true } : {}) });
    }
  }
  // A new workspace lists the standard objects in their usual order, then these in the order added.
  const shownOrder = objects.filter((o) => !o.archived).map((o) => o.key), plainOrder = [...standard.map((d) => d.key).filter((key) => shownOrder.includes(key)), ...customs.filter((key) => shownOrder.includes(key))];
  if (objects.length === all.length && shownOrder.join() !== plainOrder.join()) changes.push({ kind: "reorderObjects", order: shownOrder });
  return { version: 1, name: `${principal.org.name} shape`, description: `The objects, fields and options of ${principal.org.name}`, changes };
}
