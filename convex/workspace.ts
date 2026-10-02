import { v } from "convex/values";
import { action, internalMutation, internalQuery, type ActionCtx, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireMember } from "./identity";
import { writable } from "./authority/readonly";
import { unrestrictedHuman } from "./authority/inbox";
import { fail } from "./errors";
import { allocateSlot, kindFor, projections } from "./lib/slots";
import { pauseWork } from "./integrations/lifecycle";

// A workspace export is one JSON document: definitions, records with values keyed
// by field key and relations by record id, and the full event history. Import
// restores it into an empty workspace under new ids; deletion hands it back first.
const FORMAT = "remold.workspace", VERSION = 1, PAGE = 500;
type Raw = { org: Doc<"orgs">; objects: Doc<"objects">[]; fields: Doc<"fields">[]; records: Doc<"records">[]; events: Doc<"events">[] };
type Row = Record<string, any>;
const defined = (row: Row) => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined));
const chunks = <T,>(rows: T[]) => Array.from({ length: Math.ceil(rows.length / PAGE) }, (_, i) => rows.slice(i * PAGE, (i + 1) * PAGE));

async function requireOwner(ctx: QueryCtx | MutationCtx, orgId: Id<"orgs">) {
  const principal = await requireMember(ctx, orgId, "owner");
  // A whole-workspace copy would bypass field masks and record scopes.
  if (!unrestrictedHuman(principal)) fail("FORBIDDEN", "Only an owner without field or record restrictions can export or delete the workspace");
  return principal;
}

export const definitions = internalQuery({ args: { orgId: v.id("orgs") }, handler: async (ctx, { orgId }) => {
  const { org } = await requireOwner(ctx, orgId);
  return { org, objects: await ctx.db.query("objects").withIndex("by_org", q => q.eq("orgId", orgId)).collect(), fields: await ctx.db.query("fields").withIndex("by_object", q => q.eq("orgId", orgId)).collect() };
} });
export const page = internalQuery({ args: { orgId: v.id("orgs"), table: v.union(v.literal("records"), v.literal("events")), cursor: v.union(v.string(), v.null()) }, handler: async (ctx, { orgId, table, cursor }) => {
  await requireOwner(ctx, orgId);
  const rows = table === "records" ? ctx.db.query("records").withIndex("by_object", q => q.eq("orgId", orgId)) : ctx.db.query("events").withIndex("by_org", q => q.eq("orgId", orgId));
  return rows.paginate({ cursor, numItems: PAGE });
} });

async function collect(ctx: ActionCtx, orgId: Id<"orgs">): Promise<Raw> {
  const { org, objects, fields } = await ctx.runQuery(internal.workspace.definitions, { orgId });
  const all = async (table: "records" | "events") => { const rows: unknown[] = []; let cursor: string | null = null; for (;;) { const result: { page: unknown[]; isDone: boolean; continueCursor: string } = await ctx.runQuery(internal.workspace.page, { orgId, table, cursor }); rows.push(...result.page); if (result.isDone) return rows; cursor = result.continueCursor; } };
  return { org, objects, fields, records: await all("records") as Doc<"records">[], events: await all("events") as Doc<"events">[] };
}

function toExport({ org, objects, fields, records, events }: Raw) {
  objects = [...objects].sort((a, b) => a.order - b.order || a._creationTime - b._creationTime);
  const place = new Map(objects.map((o, i) => [o._id, i])), byId = new Map(fields.map(f => [f._id as string, f]));
  const keyed = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).map(([id, value]) => [byId.get(id)?.key ?? id, value]));
  const byObject = <T extends { objectId: Id<"objects">; _creationTime: number }>(a: T, b: T) => place.get(a.objectId)! - place.get(b.objectId)! || a._creationTime - b._creationTime;
  return {
    format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(), workspace: { name: org.name },
    objects: objects.map(o => defined({ id: o._id, key: o.key, label: o.label, labelPlural: o.labelPlural, icon: o.icon, isStandard: o.isStandard, order: o.order, titleField: o.titleFieldId ? byId.get(o.titleFieldId)?.key : undefined })),
    fields: [...fields].sort((a, b) => byObject(a, b) || a.order - b.order).map(f => defined({ id: f._id, object: f.objectId, key: f.key, label: f.label, type: f.type, options: f.options, target: f.targetObjectId, required: f.required, withTime: f.withTime, retired: f.retired, order: f.order, protectedFromAgents: f.protectedFromAgents })),
    records: [...records].sort(byObject).map(r => defined({ id: r._id, object: r.objectId, ref: r.ref, updatedAt: r.updatedAt, values: keyed(r.values) })),
    events: events.map(e => defined({ id: e._id, at: e.at ?? e._creationTime, actor: e.actor, action: e.action, object: e.objectId, record: e.recordId, before: e.before && keyed(e.before), after: e.after && keyed(e.after), reason: e.reason })),
  };
}
type Export = ReturnType<typeof toExport>;

export const exportAll = action({ args: { orgId: v.id("orgs") }, handler: async (ctx, { orgId }): Promise<Export> => toExport(await collect(ctx, orgId)) });

export const importDefinitions = internalMutation({ args: { orgId: v.id("orgs"), objects: v.array(v.any()), fields: v.array(v.any()) }, handler: async (ctx, args) => {
  const principal = await requireOwner(ctx, args.orgId);
  await writable(ctx, args.orgId);
  const used = [ctx.db.query("records").withIndex("by_object", q => q.eq("orgId", args.orgId)).first(), ctx.db.query("events").withIndex("by_org", q => q.eq("orgId", args.orgId)).first(), ctx.db.query("agents").withIndex("by_org", q => q.eq("orgId", args.orgId)).first()];
  if ((await Promise.all(used)).some(Boolean)) fail("VALIDATION", "Import needs a workspace with no records, history or agents");
  // Masks name field and object ids that import replaces; a mask must never silently stop applying.
  if ((await ctx.db.query("members").withIndex("by_org_user", q => q.eq("orgId", args.orgId)).collect()).some(m => m.readScopes !== undefined || m.hiddenFieldIds?.length)) fail("VALIDATION", "Remove member field and record restrictions before importing");
  // The seeded standard definitions are replaced by the export's own.
  for (const field of await ctx.db.query("fields").withIndex("by_object", q => q.eq("orgId", args.orgId)).collect()) await ctx.db.delete(field._id);
  for (const object of await ctx.db.query("objects").withIndex("by_org", q => q.eq("orgId", args.orgId)).collect()) await ctx.db.delete(object._id);
  const objects: Record<string, Id<"objects">> = {}, fields: Record<string, Id<"fields">> = {};
  for (const o of args.objects) objects[o.id] = await ctx.db.insert("objects", defined({ orgId: args.orgId, key: o.key, label: o.label, labelPlural: o.labelPlural, icon: o.icon, isStandard: o.isStandard, order: o.order }) as any);
  for (const f of args.fields) {
    const objectId = objects[f.object] ?? fail("VALIDATION", "Field of an unknown object"), kind = kindFor(f.type);
    fields[f.id] = await ctx.db.insert("fields", defined({ orgId: args.orgId, objectId, key: f.key, label: f.label, type: f.type, options: f.options, targetObjectId: f.target === undefined ? undefined : objects[f.target] ?? fail("VALIDATION", "Field targets an unknown object"), required: f.required, withTime: f.withTime, retired: f.retired, order: f.order, protectedFromAgents: f.protectedFromAgents, slot: kind ? await allocateSlot(ctx, args.orgId, objectId, kind) : undefined, encoding: 1 }) as any);
  }
  for (const o of args.objects) if (o.titleField !== undefined) {
    const title = args.fields.find(f => f.object === o.id && f.key === o.titleField) ?? fail("VALIDATION", "Unknown title field");
    await ctx.db.patch(objects[o.id]!, { titleFieldId: fields[title.id] });
  }
  return { objects, fields, userId: principal.user._id };
} });
// Record ids first, so relations can point anywhere; ghosts are ids for records that only history mentions.
export const importRecords = internalMutation({ args: { orgId: v.id("orgs"), objectIds: v.array(v.id("objects")), ghosts: v.array(v.id("objects")) }, handler: async (ctx, args) => {
  const { user } = await requireOwner(ctx, args.orgId);
  const insert = (objectId: Id<"objects">) => ctx.db.insert("records", { orgId: args.orgId, objectId, values: {}, title: "", createdBy: user._id, updatedAt: 0 });
  const ids = []; for (const objectId of args.objectIds) ids.push(await insert(objectId));
  const ghosts = []; for (const objectId of args.ghosts) { const id = await insert(objectId); await ctx.db.delete(id); ghosts.push(id); }
  return { ids, ghosts };
} });
export const importValues = internalMutation({ args: { orgId: v.id("orgs"), rows: v.array(v.object({ id: v.id("records"), ref: v.optional(v.string()), updatedAt: v.number(), title: v.string(), values: v.record(v.string(), v.any()) })) }, handler: async (ctx, args) => {
  await requireOwner(ctx, args.orgId);
  const fields = await ctx.db.query("fields").withIndex("by_object", q => q.eq("orgId", args.orgId)).collect();
  for (const row of args.rows) {
    const record = await ctx.db.get(row.id);
    if (!record || record.orgId !== args.orgId) fail("VALIDATION", "Unknown record");
    const own = fields.filter(f => f.objectId === record.objectId);
    await ctx.db.patch(row.id, { values: row.values, title: row.title, updatedAt: row.updatedAt, ref: row.ref, ...projections(own, row.values) });
    for (const field of own) if (field.type === "links") for (const to of (row.values[field._id] as Id<"records">[] | undefined) ?? []) await ctx.db.insert("links", { orgId: args.orgId, fieldId: field._id, fromRecordId: row.id, toRecordId: to });
  }
} });
export const importEvents = internalMutation({ args: { orgId: v.id("orgs"), rows: v.array(v.any()) }, handler: async (ctx, args) => {
  await requireOwner(ctx, args.orgId);
  for (const row of args.rows) await ctx.db.insert("events", { ...row, orgId: args.orgId });
} });
export const importFinish = internalMutation({ args: { orgId: v.id("orgs") }, handler: async (ctx, { orgId }) => {
  const principal = await requireOwner(ctx, orgId);
  const objects = await ctx.db.query("objects").withIndex("by_org", q => q.eq("orgId", orgId)).collect();
  await ctx.db.patch(orgId, { authorityFrozenAt: Math.max(Date.now(), ...objects.map(o => o._creationTime)), authorityFrozenKeys: Object.fromEntries(objects.map(o => [o._id, o.key])) });
  await ctx.db.insert("authorityAudit", { orgId, actor: principal.actor, action: "workspaceImported", targetId: orgId });
} });

export const importAll = action({ args: { orgId: v.id("orgs"), data: v.any() }, handler: async (ctx, { orgId, data }) => {
  if (data?.format !== FORMAT || data.version !== VERSION || ![data.objects, data.fields, data.records, data.events].every(Array.isArray)) fail("VALIDATION", `Expected a ${FORMAT} export, version ${VERSION}`);
  const { objects, fields } = await ctx.runMutation(internal.workspace.importDefinitions, { orgId, objects: data.objects, fields: data.fields });
  const fieldOf = new Map<string, Row>(data.fields.map((f: Row) => [`${f.object}:${f.key}`, f]));
  const relational = (object: string, values: Record<string, unknown> | null) => Object.entries(values ?? {}).flatMap(([key, value]) => { const type = fieldOf.get(`${object}:${key}`)?.type; return type === "lookup" ? [value] : type === "links" ? value as unknown[] : []; }).filter((id): id is string => typeof id === "string");
  const records = new Map<string, string>(), known = new Set(data.records.map((r: Row) => r.id)), ghosts = new Map<string, string>();
  for (const e of data.events) for (const id of [e.record, ...relational(e.object, e.before), ...relational(e.object, e.after)]) if (!known.has(id) && !ghosts.has(id)) ghosts.set(id, e.record === id ? e.object : data.objects[0].id);
  for (const [i, part] of (data.records.length ? chunks<Row>(data.records) : [[]]).entries()) {
    const extra = i === 0 ? [...ghosts] : [];
    const made = await ctx.runMutation(internal.workspace.importRecords, { orgId, objectIds: part.map(r => objects[r.object] ?? fail("VALIDATION", "Record of an unknown object")), ghosts: extra.map(([, object]) => objects[object]!) });
    part.forEach((r, j) => records.set(r.id, made.ids[j]!)); extra.forEach(([id], j) => records.set(id, made.ghosts[j]!));
  }
  const remap = (object: string, values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).flatMap(([key, value]) => {
    const field = fieldOf.get(`${object}:${key}`);
    if (!field) return [];
    const id = (old: unknown) => records.get(old as string) ?? fail("VALIDATION", "Relation to an unknown record");
    return [[fields[field.id]!, value === null ? null : field.type === "lookup" ? id(value) : field.type === "links" ? (value as unknown[]).map(id) : value]];
  }));
  const byId = new Map<string, Row>(data.records.map((r: Row) => [r.id, r])), titleKey = new Map<string, string>(data.objects.map((o: Row) => [o.id, o.titleField]));
  const title = (r: Row | undefined, depth = 0): string => {
    const key = r && titleKey.get(r.object), value = key === undefined ? undefined : r!.values[key];
    if (value == null) return "";
    return fieldOf.get(`${r!.object}:${key}`)?.type === "lookup" ? (depth < 3 ? title(byId.get(value as string), depth + 1) : "") : String(value);
  };
  for (const part of chunks<Row>(data.records)) await ctx.runMutation(internal.workspace.importValues, { orgId, rows: part.map(r => defined({ id: records.get(r.id), ref: r.ref, updatedAt: r.updatedAt, title: title(r), values: remap(r.object, r.values) }) as any) });
  for (const part of chunks<Row>(data.events)) await ctx.runMutation(internal.workspace.importEvents, { orgId, rows: part.map(e => defined({ at: e.at, actor: e.actor, action: e.action, objectId: objects[e.object], recordId: records.get(e.record), before: e.before && remap(e.object, e.before), after: e.after && remap(e.object, e.after), reason: e.reason })) });
  await ctx.runMutation(internal.workspace.importFinish, { orgId });
} });

export const beginDelete = internalMutation({ args: { orgId: v.id("orgs"), confirmName: v.string() }, handler: async (ctx, { orgId, confirmName }) => {
  const { org, actor } = await requireOwner(ctx, orgId);
  if (org.name !== confirmName) fail("VALIDATION", "Type the workspace name exactly to delete it");
  // Access ends now: nobody can sign in to or call into a workspace that is being emptied.
  await ctx.db.patch(orgId, { deletingAt: Date.now() });
  for (const member of await ctx.db.query("members").withIndex("by_org_user", q => q.eq("orgId", orgId)).collect()) await ctx.db.delete(member._id);
  for (const agent of await ctx.db.query("agents").withIndex("by_org", q => q.eq("orgId", orgId)).collect()) await ctx.db.patch(agent._id, { revokedAt: Date.now() });
  await ctx.db.insert("authorityAudit", { orgId, actor, action: "workspaceDeleted", targetId: orgId });
  await pauseWork(ctx, orgId);
  await ctx.scheduler.runAfter(0, internal.workspace.purge, { orgId });
} });

export const remove = action({ args: { orgId: v.id("orgs"), confirmName: v.string() }, handler: async (ctx, { orgId, confirmName }): Promise<Export> => {
  const raw = await collect(ctx, orgId);
  if (raw.org.name !== confirmName) fail("VALIDATION", "Type the workspace name exactly to delete it");
  const data = toExport(raw);
  await ctx.runMutation(internal.workspace.beginDelete, { orgId, confirmName });
  return data;
} });

// Every table holding workspace rows, children before the parents they are found through.
// workspace.test.ts derives the list of orgId tables from the schema and checks each one empties.
type Find = (ctx: MutationCtx, orgId: Id<"orgs">, n: number) => Promise<{ _id: string }[]>;
const byOrg = (table: string, index: string, field = "orgId"): Find => (ctx, orgId, n) => (ctx.db.query(table as any) as any).withIndex(index, (q: any) => q.eq(field, orgId)).take(n);
const under = (parents: Find, table: string, index: string, field: string): Find => async (ctx, orgId, n) => {
  const out: { _id: string }[] = [];
  for (const parent of await parents(ctx, orgId, 1000)) { if (out.length >= n) break; out.push(...await (ctx.db.query(table as any) as any).withIndex(index, (q: any) => q.eq(field, parent._id)).take(n - out.length)); }
  return out;
};
const connections = byOrg("integrationConnections", "by_org"), cursors = under(connections, "integrationCursors", "by_resource", "connectionId"), bindings = byOrg("integrationBindings", "by_org");
const purgeOrder: Find[] = [
  under(cursors, "integrationPages", "by_page", "cursorId"), under(byOrg("safetyTargets", "by_org"), "integrationReceipts", "by_target", "targetId"),
  byOrg("safetyTargets", "by_org"), under(cursors, "integrationLookups", "by_traversal", "cursorId"), cursors,
  under(connections, "integrationIntents", "by_logical", "connectionId"), under(bindings, "integrationCallbacks", "by_event", "bindingId"), under(bindings, "integrationObservations", "by_binding", "bindingId"),
  byOrg("integrationEvents", "by_org_at"), byOrg("integrationOps", "by_org"), bindings, connections, byOrg("secretReferences", "by_org"),
  byOrg("consent", "by_recipient"), byOrg("usageBudgets", "by_key", "key"), byOrg("agentInbox", "by_org_status"), byOrg("suggestions", "by_org_status"),
  byOrg("capabilityGrants", "by_agent"), byOrg("agents", "by_org"), byOrg("authorityAudit", "by_org"), byOrg("opsEvents", "by_org"), byOrg("invites", "by_org"), byOrg("members", "by_org_user"),
  byOrg("links", "by_record_any"), byOrg("events", "by_org"), byOrg("records", "by_object"), byOrg("fields", "by_object"), byOrg("objects", "by_org"),
];
const BATCH = 200;
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
