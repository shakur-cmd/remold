import { v } from "convex/values";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireMember } from "./identity";
import { unrestrictedHuman } from "./authority/inbox";
import { writable } from "./authority/readonly";
import { fail } from "./errors";
import { allocateSlot, kindFor, projections } from "./lib/slots";
import { sha256 } from "./lib/sha256";
import { pauseWork } from "./integrations/lifecycle";

// A workspace export is one JSON document read in one query, so it is one consistent snapshot:
// definitions, records (values keyed by field key, relations by record id) and the full history.
// Import restores it in one mutation, all or nothing. Deletion needs the export's sha256 back,
// which proves the owner holds a copy of exactly what is about to be removed.
const FORMAT = "remold.workspace", VERSION = 1;
// Objects + fields + records + events + relation values. Keeps one export inside a query's read
// limits and one import well inside a mutation's write limits.
export const MAX_ROWS = 4000;
const MAX_BYTES = 4_000_000;
const TYPES = ["text", "number", "select", "date", "boolean", "lookup", "links"] as const;
type Row = Record<string, any>;
const defined = (row: Row) => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined));
// The sha256 covers the export without its sha256 field, as JSON with keys sorted at every level,
// so anyone can recompute it from the file whatever order a tool writes keys in.
export const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Row)[k])}`).join(",")}}` : JSON.stringify(value);
const tooBig = (what: string) => fail("VALIDATION", `${what} is larger than one file can hold (${MAX_ROWS} rows or ${MAX_BYTES / 1e6} MB). Ask shakur@codemyvibe.com for a staged export.`);

async function requireOwner(ctx: QueryCtx | MutationCtx, orgId: Id<"orgs">) {
  const principal = await requireMember(ctx, orgId, "owner");
  // A whole-workspace copy would bypass field masks and record scopes.
  if (!unrestrictedHuman(principal)) fail("FORBIDDEN", "Only an owner without field or record restrictions can export or delete the workspace");
  return principal;
}

async function snapshot(ctx: QueryCtx, orgId: Id<"orgs">) {
  const { org } = await requireOwner(ctx, orgId);
  const objects = (await ctx.db.query("objects").withIndex("by_org", q => q.eq("orgId", orgId)).collect()).sort((a, b) => a.order - b.order || a._creationTime - b._creationTime);
  const fields = await ctx.db.query("fields").withIndex("by_object", q => q.eq("orgId", orgId)).collect();
  const left = MAX_ROWS - objects.length - fields.length;
  const records = await ctx.db.query("records").withIndex("by_object", q => q.eq("orgId", orgId)).take(left + 1);
  const events = await ctx.db.query("events").withIndex("by_org", q => q.eq("orgId", orgId)).take(left - records.length + 1);
  const byId = new Map(fields.map(f => [f._id as string, f]));
  const relations = records.reduce((n, r) => n + Object.entries(r.values).reduce((m, [id, value]) => m + (byId.get(id)?.type === "links" ? (value as unknown[]).length : 0), 0), 0);
  if (records.length + events.length + relations > left) tooBig("This workspace");
  const place = new Map(objects.map((o, i) => [o._id, i]));
  const keyed = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).map(([id, value]) => [byId.get(id)?.key ?? id, value]));
  const byObject = <T extends { objectId: Id<"objects">; _creationTime: number }>(a: T, b: T) => place.get(a.objectId)! - place.get(b.objectId)! || a._creationTime - b._creationTime;
  // History names people as text; an agent from another workspace is never looked up.
  const names = new Map<string, string>();
  const by = async (actor: Doc<"events">["actor"]) => {
    if (actor.kind === "imported") return actor.name;
    if (actor.kind === "automation") return "Automation";
    if (!names.has(actor.id)) {
      const row = actor.kind === "user" ? await ctx.db.get(actor.id as Id<"users">) : await ctx.db.get(actor.id as Id<"agents">);
      names.set(actor.id, row && (!("orgId" in row) || row.orgId === orgId) ? (actor.kind === "agent" ? `${row.name} (agent)` : row.name) : actor.kind === "agent" ? "An agent" : "A person");
    }
    return names.get(actor.id)!;
  };
  const body = {
    format: FORMAT, version: VERSION, workspace: { name: org.name },
    objects: objects.map(o => defined({ id: o._id, key: o.key, label: o.label, labelPlural: o.labelPlural, icon: o.icon, isStandard: o.isStandard, order: o.order, titleField: o.titleFieldId ? byId.get(o.titleFieldId)?.key : undefined })),
    fields: [...fields].sort((a, b) => byObject(a, b) || a.order - b.order).map(f => defined({ id: f._id, object: f.objectId, key: f.key, label: f.label, type: f.type, options: f.options, target: f.targetObjectId, required: f.required, withTime: f.withTime, retired: f.retired, order: f.order, protectedFromAgents: f.protectedFromAgents })),
    records: [...records].sort(byObject).map(r => defined({ id: r._id, object: r.objectId, ref: r.ref, updatedAt: r.updatedAt, values: keyed(r.values) })),
    events: await Promise.all(events.map(async e => defined({ id: e._id, at: e.at ?? e._creationTime, by: await by(e.actor), action: e.action, object: e.objectId, record: e.recordId, before: e.before && keyed(e.before), after: e.after && keyed(e.after), reason: e.reason }))),
  };
  const text = canonical(body);
  if (text.length > MAX_BYTES) tooBig("This workspace");
  return { org, body, sha256: sha256(text) };
}

export const exportAll = query({ args: { orgId: v.id("orgs") }, handler: async (ctx, { orgId }) => { const { body, sha256 } = await snapshot(ctx, orgId); return { ...body, sha256 }; } });

// Checks the whole document before anything is written; every refusal names its reason.
function validate(data: any) {
  const bad = (why: string): never => fail("VALIDATION", `Import refused: ${why}`);
  const is = { string: (x: unknown): x is string => typeof x === "string", number: (x: unknown): x is number => typeof x === "number" && Number.isFinite(x), boolean: (x: unknown): x is boolean => typeof x === "boolean", object: (x: unknown): x is Row => !!x && typeof x === "object" && !Array.isArray(x) };
  if (!is.object(data) || data.format !== FORMAT || data.version !== VERSION) bad(`expected a ${FORMAT} export, version ${VERSION}`);
  if (![data.objects, data.fields, data.records, data.events].every(Array.isArray)) bad("objects, fields, records and events must be lists");
  if (JSON.stringify(data).length > MAX_BYTES * 1.1 || data.objects.length + data.fields.length + data.records.length + data.events.length > MAX_ROWS) tooBig("This file");
  const only = (row: unknown, what: string, keys: string[]) => { if (!is.object(row)) bad(`${what} is not an object`); for (const key of Object.keys(row as Row)) if (!keys.includes(key)) bad(`${what} has unknown property "${key}"`); return row as Row; };
  const unique = (seen: Set<string>, id: unknown, what: string) => { if (!is.string(id) || !id) bad(`${what} has no id`); if (seen.has(id as string)) bad(`duplicate ${what} "${id}"`); seen.add(id as string); };
  const validKey = (key: unknown, what: string) => { if (!is.string(key) || !/^[a-z][a-zA-Z0-9]*$/.test(key)) bad(`${what} has an invalid key`); };
  const objectIds = new Set<string>(), objectKeys = new Set<string>();
  for (const o of data.objects) {
    only(o, "an object", ["id", "key", "label", "labelPlural", "icon", "isStandard", "order", "titleField"]);
    unique(objectIds, o.id, "object id"); validKey(o.key, `object ${o.id}`);
    if (objectKeys.has(o.key)) bad(`duplicate object key "${o.key}"`); objectKeys.add(o.key);
    if (!is.string(o.label) || !is.string(o.labelPlural) || !is.boolean(o.isStandard) || !is.number(o.order) || (o.icon !== undefined && !is.string(o.icon))) bad(`object "${o.key}" has a missing or invalid property`);
  }
  const fieldIds = new Set<string>(), fieldOf = new Map<string, Row>();
  for (const f of data.fields) {
    only(f, "a field", ["id", "object", "key", "label", "type", "options", "target", "required", "withTime", "retired", "order", "protectedFromAgents"]);
    unique(fieldIds, f.id, "field id"); validKey(f.key, `field ${f.id}`);
    if (!objectIds.has(f.object)) bad(`field "${f.key}" belongs to an unknown object`);
    if (fieldOf.has(`${f.object}:${f.key}`)) bad(`duplicate field key "${f.key}" on one object`);
    if (!TYPES.includes(f.type) || !is.string(f.label) || !is.boolean(f.required) || !is.boolean(f.retired) || !is.number(f.order)) bad(`field "${f.key}" has a missing or invalid property`);
    if (f.type === "select" ? !Array.isArray(f.options) || !f.options.length || new Set(f.options.map((o: Row) => o?.id)).size !== f.options.length || f.options.some((o: Row) => !is.string(o?.id) || !is.string(o?.label)) : f.options !== undefined) bad(`field "${f.key}" has invalid options`);
    if (f.target !== undefined && ((f.type !== "lookup" && f.type !== "links") || !objectIds.has(f.target))) bad(`field "${f.key}" has an invalid target`);
    if ((f.withTime !== undefined && (f.type !== "date" || !is.boolean(f.withTime))) || (f.protectedFromAgents !== undefined && !is.boolean(f.protectedFromAgents))) bad(`field "${f.key}" has a missing or invalid property`);
    fieldOf.set(`${f.object}:${f.key}`, f);
  }
  for (const o of data.objects) if (o.titleField !== undefined && !fieldOf.has(`${o.id}:${o.titleField}`)) bad(`object "${o.key}" names an unknown title field`);
  const recordIds = new Set<string>(), recordObject = new Map<string, string>(), refs = new Set<string>();
  for (const r of data.records) { only(r, "a record", ["id", "object", "ref", "updatedAt", "values"]); unique(recordIds, r.id, "record id"); recordObject.set(r.id, r.object); }
  // History may name records that were deleted; live values may not.
  const check = (object: string, values: unknown, what: string, history: boolean) => {
    if (!is.object(values)) bad(`${what} has no values`);
    for (const [key, value] of Object.entries(values as Row)) {
      const f = fieldOf.get(`${object}:${key}`) ?? bad(`${what} has unknown field "${key}"`);
      if (value === null && history) continue;
      const related = (id: unknown) => is.string(id) && (history || (recordIds.has(id) && (!f.target || recordObject.get(id) === f.target)));
      const ok = f.type === "text" ? is.string(value) : f.type === "number" || f.type === "date" ? is.number(value) : f.type === "boolean" ? is.boolean(value) : f.type === "select" ? f.options.some((o: Row) => o.id === value) : f.type === "lookup" ? related(value) : Array.isArray(value) && value.every(related);
      if (!ok) bad(`${what} has an invalid ${f.type === "lookup" || f.type === "links" ? "relation" : "value"} in "${key}"`);
    }
  };
  for (const r of data.records) {
    if (!objectIds.has(r.object)) bad(`record ${r.id} belongs to an unknown object`);
    if (!is.number(r.updatedAt) || (r.ref !== undefined && (!is.string(r.ref) || refs.has(r.ref)))) bad(`record ${r.id} has an invalid or duplicate ref or time`);
    if (r.ref !== undefined) refs.add(r.ref);
    check(r.object, r.values, `record ${r.id}`, false);
  }
  const eventIds = new Set<string>();
  for (const e of data.events) {
    only(e, "an event", ["id", "at", "by", "action", "object", "record", "before", "after", "reason"]);
    unique(eventIds, e.id, "event id");
    if (!objectIds.has(e.object) || !is.string(e.record) || !is.number(e.at) || !is.string(e.by) || !["create", "update", "delete"].includes(e.action) || (e.reason !== undefined && !is.string(e.reason))) bad(`event ${e.id} has a missing or invalid property`);
    if ((e.action === "create") !== (e.before === null) || (e.action === "delete") !== (e.after === null)) bad(`event ${e.id} does not match its action`);
    if (e.before !== null) check(e.object, e.before, `event ${e.id}`, true);
    if (e.after !== null) check(e.object, e.after, `event ${e.id}`, true);
  }
  return fieldOf;
}

export const importAll = mutation({ args: { orgId: v.id("orgs"), data: v.any() }, handler: async (ctx, { orgId, data }) => {
  const principal = await requireOwner(ctx, orgId);
  await writable(ctx, orgId);
  const used = [ctx.db.query("records").withIndex("by_object", q => q.eq("orgId", orgId)).first(), ctx.db.query("events").withIndex("by_org", q => q.eq("orgId", orgId)).first(), ctx.db.query("agents").withIndex("by_org", q => q.eq("orgId", orgId)).first()];
  if ((await Promise.all(used)).some(Boolean)) fail("VALIDATION", "Import needs a workspace with no records, history or agents");
  // Masks name field and object ids that import replaces; a mask must never silently stop applying.
  if ((await ctx.db.query("members").withIndex("by_org_user", q => q.eq("orgId", orgId)).collect()).some(m => m.readScopes !== undefined || m.hiddenFieldIds?.length)) fail("VALIDATION", "Remove member field and record restrictions before importing");
  const fieldOf = validate(data);
  // The seeded standard definitions are replaced by the export's own.
  for (const field of await ctx.db.query("fields").withIndex("by_object", q => q.eq("orgId", orgId)).collect()) await ctx.db.delete(field._id);
  for (const object of await ctx.db.query("objects").withIndex("by_org", q => q.eq("orgId", orgId)).collect()) await ctx.db.delete(object._id);
  const objects = new Map<string, Id<"objects">>(), fields = new Map<string, Doc<"fields">>(), records = new Map<string, Id<"records">>();
  for (const o of data.objects) objects.set(o.id, await ctx.db.insert("objects", defined({ orgId, key: o.key, label: o.label, labelPlural: o.labelPlural, icon: o.icon, isStandard: o.isStandard, order: o.order }) as any));
  for (const f of data.fields) {
    const objectId = objects.get(f.object)!, kind = kindFor(f.type);
    const id = await ctx.db.insert("fields", defined({ orgId, objectId, key: f.key, label: f.label, type: f.type, options: f.options, targetObjectId: f.target && objects.get(f.target), required: f.required, withTime: f.withTime, retired: f.retired, order: f.order, protectedFromAgents: f.protectedFromAgents, slot: kind ? await allocateSlot(ctx, orgId, objectId, kind) : undefined, encoding: 1 }) as any);
    fields.set(f.id, (await ctx.db.get(id))!);
  }
  for (const o of data.objects) if (o.titleField !== undefined) await ctx.db.patch(objects.get(o.id)!, { titleFieldId: fields.get(fieldOf.get(`${o.id}:${o.titleField}`)!.id)!._id });
  const blank = (objectId: Id<"objects">) => ctx.db.insert("records", { orgId, objectId, values: {}, title: "", createdBy: principal.user._id, updatedAt: 0 });
  for (const r of data.records) records.set(r.id, await blank(objects.get(r.object)!));
  // Records only history mentions get an id that never holds data, so events keep a valid record id.
  const ghost = async (old: string, object: string) => { if (!records.has(old)) { const id = await blank(objects.get(object)!); await ctx.db.delete(id); records.set(old, id); } return records.get(old)!; };
  const remap = async (object: string, values: Row) => {
    const out: Row = {};
    for (const [key, value] of Object.entries(values)) {
      const f = fieldOf.get(`${object}:${key}`)!, field = fields.get(f.id)!, to = (id: string) => ghost(id, f.target ?? object);
      out[field._id] = value === null ? null : f.type === "lookup" ? await to(value) : f.type === "links" ? await Promise.all(value.map(to)) : value;
    }
    return out;
  };
  const byId = new Map<string, Row>(data.records.map((r: Row) => [r.id, r])), titleKey = new Map<string, string>(data.objects.map((o: Row) => [o.id, o.titleField]));
  const title = (r: Row | undefined, depth = 0): string => {
    const key = r && titleKey.get(r.object), value = key === undefined ? undefined : r!.values[key];
    if (value == null) return "";
    return fieldOf.get(`${r!.object}:${key}`)!.type === "lookup" ? (depth < 3 ? title(byId.get(value), depth + 1) : "") : String(value);
  };
  const all = [...fields.values()];
  for (const r of data.records) {
    const id = records.get(r.id)!, values = await remap(r.object, r.values), own = all.filter(f => f.objectId === objects.get(r.object));
    await ctx.db.patch(id, { values, title: title(r), updatedAt: r.updatedAt, ref: r.ref, ...projections(own, values) });
    for (const field of own) if (field.type === "links") for (const to of (values[field._id] as Id<"records">[] | undefined) ?? []) await ctx.db.insert("links", { orgId, fieldId: field._id, fromRecordId: id, toRecordId: to });
  }
  // Written in their original order, so history pages in the same order as `at`.
  for (const e of [...data.events].sort((a: Row, b: Row) => a.at - b.at)) await ctx.db.insert("events", defined({ orgId, at: e.at, actor: { kind: "imported" as const, name: e.by }, action: e.action, objectId: objects.get(e.object)!, recordId: await ghost(e.record, e.object), before: e.before && await remap(e.object, e.before), after: e.after && await remap(e.object, e.after), reason: e.reason }) as any);
  const fresh = await ctx.db.query("objects").withIndex("by_org", q => q.eq("orgId", orgId)).collect();
  await ctx.db.patch(orgId, { authorityFrozenAt: Math.max(Date.now(), ...fresh.map(o => o._creationTime)), authorityFrozenKeys: Object.fromEntries(fresh.map(o => [o._id, o.key])) });
  await ctx.db.insert("authorityAudit", { orgId, actor: principal.actor, action: "workspaceImported", targetId: orgId });
} });

// Step two of deletion. The owner already holds the export: its sha256 must match the workspace as it
// is now, so a change after the export means exporting again. One small write; the purge does the rest.
export const confirmDelete = mutation({ args: { orgId: v.id("orgs"), confirmName: v.string(), sha256: v.string() }, handler: async (ctx, { orgId, confirmName, sha256: held }) => {
  const { org, sha256: current } = await snapshot(ctx, orgId);
  if (current !== held.trim().toLowerCase()) fail("VALIDATION", "That sha256 is not the current export of this workspace; export again");
  if (org.name !== confirmName) fail("VALIDATION", "Type the workspace name exactly to delete it");
  await ctx.db.patch(orgId, { deletingAt: Date.now() });
  await pauseWork(ctx, orgId);
  await ctx.scheduler.runAfter(0, internal.workspace.purge, { orgId });
} });

// Every table holding workspace rows, children before the parents they are found through.
// workspace.test.ts derives the list of orgId tables from the schema and checks each one empties.
type Find = (ctx: MutationCtx, orgId: Id<"orgs">, n: number) => Promise<{ _id: string }[]>;
const byOrg = (table: string, index: string, field = "orgId"): Find => (ctx, orgId, n) => (ctx.db.query(table as any) as any).withIndex(index, (q: any) => q.eq(field, orgId)).take(n);
const under = (parents: Find, table: string, index: string, field: string): Find => async (ctx, orgId, n) => {
  const out: { _id: string }[] = [];
  for (const parent of await parents(ctx, orgId, 100)) { if (out.length >= n) break; out.push(...await (ctx.db.query(table as any) as any).withIndex(index, (q: any) => q.eq(field, parent._id)).take(n - out.length)); }
  return out;
};
const connections = byOrg("integrationConnections", "by_org"), cursors = under(connections, "integrationCursors", "by_resource", "connectionId"), bindings = byOrg("integrationBindings", "by_org");
const purgeOrder: Find[] = [
  byOrg("members", "by_org_user"), byOrg("capabilityGrants", "by_agent"), byOrg("agents", "by_org"), byOrg("invites", "by_org"),
  under(cursors, "integrationPages", "by_page", "cursorId"), under(byOrg("safetyTargets", "by_org"), "integrationReceipts", "by_target", "targetId"),
  byOrg("safetyTargets", "by_org"), under(cursors, "integrationLookups", "by_traversal", "cursorId"), cursors,
  under(connections, "integrationIntents", "by_logical", "connectionId"), under(bindings, "integrationCallbacks", "by_event", "bindingId"), under(bindings, "integrationObservations", "by_binding", "bindingId"),
  byOrg("integrationEvents", "by_org_at"), byOrg("integrationOps", "by_org"), bindings, connections, byOrg("secretReferences", "by_org"),
  byOrg("consent", "by_recipient"), byOrg("usageBudgets", "by_key", "key"), byOrg("agentInbox", "by_org_status"), byOrg("suggestions", "by_org_status"),
  byOrg("authorityAudit", "by_org"), byOrg("opsEvents", "by_org"), byOrg("billingEvents", "by_org"),
  byOrg("links", "by_record_any"), byOrg("events", "by_org"), byOrg("records", "by_object"), byOrg("fields", "by_object"), byOrg("objects", "by_org"),
];
export const BATCH = 200;
export const purge = internalMutation({ args: { orgId: v.id("orgs") }, handler: async (ctx, { orgId }) => {
  const org = await ctx.db.get(orgId);
  if (!org?.deletingAt) return;
  for (const find of purgeOrder) {
    const rows = await find(ctx, orgId, BATCH);
    if (!rows.length) continue;
    for (const row of rows) await ctx.db.delete(row._id as any);
    await ctx.scheduler.runAfter(0, internal.workspace.purge, { orgId });
    return;
  }
  await ctx.db.delete(orgId);
} });
