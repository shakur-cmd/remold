declare const process: { env: Record<string, string | undefined> };
import { v } from "convex/values";
import { action, internalMutation, internalQuery, mutation, type ActionCtx, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getPrincipal, requireMember } from "./identity";
import { unrestrictedHuman } from "./authority/inbox";
import { FENCE_MS } from "./authority/readonly";
import { mayCreate } from "./orgs";
import { fail } from "./errors";
import { allocateSlot, kindFor, projections } from "./lib/slots";
import { pauseWork } from "./integrations/lifecycle";

// Export, import and deletion of a whole workspace, each in bounded steps so no single Convex function
// comes near its limits (4,096 reads, 8,192 writes, 16 MiB read, 8 MiB arguments or result, 1 s of code).
// Export: a short write fence, then page queries; the action assembles one JSON file in file storage.
// Import: the file is uploaded to storage, validated whole, then staged into a new hidden workspace and
// published; a failed import is purged. Deletion: one marker write, then a scheduled bounded purge.
const FORMAT = "remold.workspace", VERSION = 1;
const PAGE = 500, PAGE_BYTES = 4 * 1024 * 1024;
const WRITES = 300, BATCH_BYTES = 2 * 1024 * 1024;
const MAX_DEFINITIONS = 1000;
const DOWNLOAD_MS = 60 * 60_000, EXPORT_FRESH_MS = 24 * 60 * 60_000;
export const NO_EXPORT = "DELETE WITHOUT EXPORT";
// Bytes, as UTF-8. The defaults are what the local Convex backend proved (ops/workspace/limits.mjs).
const limit = (name: string, fallback: number) => Number(process.env[name]) > 0 ? Number(process.env[name]) : fallback;
export const MAX_EXPORT_BYTES = () => limit("REMOLD_EXPORT_MAX_BYTES", 64 * 1024 * 1024);
export const MAX_IMPORT_BYTES = () => limit("REMOLD_IMPORT_MAX_BYTES", 32 * 1024 * 1024);
// Records + events + link values. The local backend writes about 70 of these a second through bounded
// batches (10,000 records with their history took about 5 minutes), and an action may run 10 minutes.
export const MAX_IMPORT_ROWS = () => limit("REMOLD_IMPORT_MAX_ROWS", 25000);
const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;
const utf8 = (text: string) => new TextEncoder().encode(text).length;
const TYPES = ["text", "number", "select", "date", "boolean", "lookup", "links"] as const;
type Row = Record<string, any>;
const defined = (row: Row) => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined));
const keyed = (byId: Map<string, Doc<"fields">>, values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).map(([id, value]) => [byId.get(id)?.key ?? id, value]));

async function requireOwner(ctx: QueryCtx | MutationCtx, orgId: Id<"orgs">) {
  const principal = await requireMember(ctx, orgId, "owner");
  // A whole-workspace copy would bypass field masks and record scopes.
  if (!unrestrictedHuman(principal)) fail("FORBIDDEN", "Only an owner without field or record restrictions can export or delete the workspace");
  return principal;
}

// ---- Export ----
// The fence: writes through the shared write path (writable) are refused while exportingAt is fresh,
// so every page reads the same workspace. It lapses on its own after FENCE_MS.
async function fenced(ctx: QueryCtx | MutationCtx, orgId: Id<"orgs">, token: number) {
  const principal = await requireOwner(ctx, orgId);
  if (principal.org.exportingAt !== token || Date.now() - token > FENCE_MS) fail("CONFLICT", "The export took too long or was interrupted; export again");
  return principal;
}
export const exportBegin = internalMutation({ args: { orgId: v.id("orgs") }, handler: async (ctx, { orgId }) => {
  const { org } = await requireOwner(ctx, orgId);
  if (org.exportingAt && Date.now() - org.exportingAt < FENCE_MS) fail("CONFLICT", "An export of this workspace is already running");
  const token = Date.now();
  await ctx.db.patch(orgId, { exportingAt: token });
  return token;
} });
export const exportEnd = internalMutation({ args: { orgId: v.id("orgs"), token: v.number(), done: v.boolean() }, handler: async (ctx, { orgId, token, done }) => {
  if (done) await fenced(ctx, orgId, token);
  const org = await ctx.db.get(orgId);
  if (org?.exportingAt === token) await ctx.db.patch(orgId, { exportingAt: undefined, ...(done ? { exportedAt: Date.now() } : {}) });
} });
export const exportDefinitions = internalQuery({ args: { orgId: v.id("orgs"), token: v.number() }, handler: async (ctx, { orgId, token }) => {
  const { org } = await fenced(ctx, orgId, token);
  const objects = (await ctx.db.query("objects").withIndex("by_org", q => q.eq("orgId", orgId)).take(MAX_DEFINITIONS)).sort((a, b) => a.order - b.order || a._creationTime - b._creationTime);
  const fields = await ctx.db.query("fields").withIndex("by_object", q => q.eq("orgId", orgId)).take(MAX_DEFINITIONS);
  const place = new Map(objects.map((o, i) => [o._id, i])), byId = new Map(fields.map(f => [f._id as string, f]));
  return {
    name: org.name, objectIds: objects.map(o => o._id),
    objects: objects.map(o => defined({ id: o._id, key: o.key, label: o.label, labelPlural: o.labelPlural, icon: o.icon, isStandard: o.isStandard, order: o.order, titleField: o.titleFieldId ? byId.get(o.titleFieldId)?.key : undefined })),
    fields: [...fields].sort((a, b) => place.get(a.objectId)! - place.get(b.objectId)! || a.order - b.order || a._creationTime - b._creationTime).map(f => defined({ id: f._id, object: f.objectId, key: f.key, label: f.label, type: f.type, options: f.options, target: f.targetObjectId, required: f.required, withTime: f.withTime, retired: f.retired, order: f.order, protectedFromAgents: f.protectedFromAgents })),
  };
} });
const page = { cursor: v.union(v.string(), v.null()) };
export const exportRecords = internalQuery({ args: { orgId: v.id("orgs"), token: v.number(), objectId: v.id("objects"), ...page }, handler: async (ctx, { orgId, token, objectId, cursor }) => {
  await fenced(ctx, orgId, token);
  const byId = new Map((await ctx.db.query("fields").withIndex("by_object", q => q.eq("orgId", orgId).eq("objectId", objectId)).collect()).map(f => [f._id as string, f]));
  const result = await ctx.db.query("records").withIndex("by_object", q => q.eq("orgId", orgId).eq("objectId", objectId)).paginate({ cursor, numItems: PAGE, maximumBytesRead: PAGE_BYTES });
  return { ...result, page: result.page.map(r => defined({ id: r._id, object: r.objectId, ref: r.ref, updatedAt: r.updatedAt, values: keyed(byId, r.values) })) };
} });
export const exportEvents = internalQuery({ args: { orgId: v.id("orgs"), token: v.number(), ...page }, handler: async (ctx, { orgId, token, cursor }) => {
  await fenced(ctx, orgId, token);
  const result = await ctx.db.query("events").withIndex("by_org", q => q.eq("orgId", orgId)).paginate({ cursor, numItems: PAGE, maximumBytesRead: PAGE_BYTES });
  const byId = new Map<string, Doc<"fields">>(), names = new Map<string, string>();
  for (const e of result.page) for (const id of Object.keys({ ...e.before, ...e.after })) if (!byId.has(id)) { const fieldId = ctx.db.normalizeId("fields", id), field = fieldId && await ctx.db.get(fieldId); if (field && field.orgId === orgId) byId.set(id, field); }
  // History names people as text; an agent from another workspace is never looked up.
  const by = async (actor: Doc<"events">["actor"]) => {
    if (actor.kind === "imported") return actor.name;
    if (actor.kind === "automation") return "Automation";
    if (!names.has(actor.id)) {
      const row = actor.kind === "user" ? await ctx.db.get(actor.id as Id<"users">) : await ctx.db.get(actor.id as Id<"agents">);
      names.set(actor.id, row && (!("orgId" in row) || row.orgId === orgId) ? (actor.kind === "agent" ? `${row.name} (agent)` : row.name) : actor.kind === "agent" ? "An agent" : "A person");
    }
    return names.get(actor.id)!;
  };
  return { ...result, page: await Promise.all(result.page.map(async e => defined({ id: e._id, at: e.at ?? e._creationTime, by: await by(e.actor), action: e.action, object: e.objectId, record: e.recordId, before: e.before && keyed(byId, e.before), after: e.after && keyed(byId, e.after), reason: e.reason }))) };
} });
export const dropFile = internalMutation({ args: { storageId: v.id("_storage") }, handler: async (ctx, { storageId }) => { await ctx.storage.delete(storageId).catch(() => undefined); } });

// The file lives in Convex storage for an hour; the browser downloads it from the returned URL.
export const exportAll = action({ args: { orgId: v.id("orgs") }, handler: async (ctx, { orgId }): Promise<{ url: string; storageId: Id<"_storage">; bytes: number; records: number; events: number }> => {
  const token: number = await ctx.runMutation(internal.workspace.exportBegin, { orgId });
  let storageId: Id<"_storage"> | undefined;
  try {
    const parts: string[] = [], max = MAX_EXPORT_BYTES();
    let bytes = 0, records = 0, events = 0;
    const push = (text: string) => { bytes += utf8(text); if (bytes > max) fail("VALIDATION", `This workspace is larger than ${mb(max)}, more than one export file holds here. Larger workspaces are exported by request: shakur@codemyvibe.com.`); parts.push(text); };
    const list = (rows: unknown[], first: boolean) => { if (rows.length) push((first ? "" : ",") + rows.map(row => JSON.stringify(row)).join(",")); return first && !rows.length; };
    const defs = await ctx.runQuery(internal.workspace.exportDefinitions, { orgId, token });
    push(`{"format":${JSON.stringify(FORMAT)},"version":${VERSION},"workspace":${JSON.stringify({ name: defs.name })},"objects":${JSON.stringify(defs.objects)},"fields":${JSON.stringify(defs.fields)},"records":[`);
    let first = true;
    for (const objectId of defs.objectIds) for (let cursor: string | null = null; ;) {
      const result: { page: unknown[]; isDone: boolean; continueCursor: string } = await ctx.runQuery(internal.workspace.exportRecords, { orgId, token, objectId, cursor });
      first = list(result.page, first); records += result.page.length;
      if (result.isDone) break; cursor = result.continueCursor;
    }
    push(`],"events":[`);
    first = true;
    for (let cursor: string | null = null; ;) {
      const result: { page: unknown[]; isDone: boolean; continueCursor: string } = await ctx.runQuery(internal.workspace.exportEvents, { orgId, token, cursor });
      first = list(result.page, first); events += result.page.length;
      if (result.isDone) break; cursor = result.continueCursor;
    }
    push("]}");
    storageId = await ctx.storage.store(new Blob(parts, { type: "application/json" }));
    await ctx.runMutation(internal.workspace.exportEnd, { orgId, token, done: true });
    await ctx.scheduler.runAfter(DOWNLOAD_MS, internal.workspace.dropFile, { storageId });
    return { url: (await ctx.storage.getUrl(storageId))!, storageId, bytes, records, events };
  } catch (error) {
    if (storageId) await ctx.storage.delete(storageId);
    await ctx.runMutation(internal.workspace.exportEnd, { orgId, token, done: false });
    throw error;
  }
} });

// ---- Import ----
// Checks the whole document before anything is written; every refusal names its reason.
function validate(data: any) {
  const bad = (why: string): never => fail("VALIDATION", `Import refused: ${why}`);
  const is = { string: (x: unknown): x is string => typeof x === "string", number: (x: unknown): x is number => typeof x === "number" && Number.isFinite(x), boolean: (x: unknown): x is boolean => typeof x === "boolean", object: (x: unknown): x is Row => !!x && typeof x === "object" && !Array.isArray(x) };
  if (!is.object(data) || data.format !== FORMAT || data.version !== VERSION) bad(`expected a ${FORMAT} export, version ${VERSION}`);
  if (![data.objects, data.fields, data.records, data.events].every(Array.isArray)) bad("objects, fields, records and events must be lists");
  if (!is.object(data.workspace) || !is.string(data.workspace.name) || !data.workspace.name.trim()) bad("the workspace has no name");
  if (data.objects.length + data.fields.length > MAX_DEFINITIONS) bad(`more than ${MAX_DEFINITIONS} objects and fields`);
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
      // A record is written once, with its link rows, in one bounded mutation.
      if (!history && f.type === "links" && (value as unknown[]).length >= WRITES) bad(`${what} has more than ${WRITES - 1} relation values in "${key}"`);
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


// Records go in dependency order, so each is inserted once with final values: a record waits until every
// record it points at has an id. Records on a cycle are inserted without the relations that close the cycle
// and get one bounded fix-up write each at the end. Batches stay under WRITES (a record plus its link rows)
// and BATCH_BYTES of arguments.
export function planImport(data: Row, fieldOf: Map<string, Row>) {
  const relational = (object: string, key: string) => { const type = fieldOf.get(`${object}:${key}`)?.type; return type === "lookup" || type === "links"; };
  const targets = (r: Row) => new Set(Object.entries(r.values as Row).flatMap(([key, value]) => relational(r.object, key) ? (Array.isArray(value) ? value : [value]) : []).filter((id): id is string => typeof id === "string"));
  const deps = new Map<string, Set<string>>(data.records.map((r: Row) => [r.id, targets(r)]));
  const waiting = new Map<string, string[]>(), left = new Map<string, number>();
  for (const [id, set] of deps) { left.set(id, [...set].filter(t => t !== id).length); for (const t of set) if (t !== id) waiting.set(t, [...(waiting.get(t) ?? []), id]); }
  // Within a level, records keep their order in the file, so creation order survives where dependencies allow.
  const position = new Map<string, number>(data.records.map((r: Row, i: number) => [r.id, i]));
  const levels: string[][] = [];
  let ready = [...deps.keys()].filter(id => left.get(id) === 0 && !deps.get(id)!.has(id));
  const placed = new Set<string>();
  while (ready.length) {
    ready.sort((x, y) => position.get(x)! - position.get(y)!);
    levels.push(ready); for (const id of ready) placed.add(id);
    const next: string[] = [];
    for (const id of ready) for (const w of waiting.get(id) ?? []) { left.set(w, left.get(w)! - 1); if (left.get(w) === 0 && !deps.get(w)!.has(w)) next.push(w); }
    ready = next;
  }
  const cyclic = [...deps.keys()].filter(id => !placed.has(id));
  if (cyclic.length) levels.push(cyclic);
  const weight = (r: Row) => 1 + Object.entries(r.values as Row).reduce((n, [key, value]) => n + (fieldOf.get(`${r.object}:${key}`)?.type === "links" ? (value as unknown[]).length : 0), 0);
  const byId = new Map<string, Row>(data.records.map((r: Row) => [r.id, r]));
  const batches: Row[][] = [];
  for (const level of levels) {
    let batch: Row[] = [], writes = 0, bytes = 0;
    for (const id of level) {
      const r = byId.get(id)!, w = weight(r), b = utf8(JSON.stringify(r));
      if (batch.length && (writes + w > WRITES || bytes + b > BATCH_BYTES)) { batches.push(batch); batch = []; writes = 0; bytes = 0; }
      batch.push(r); writes += w; bytes += b;
    }
    if (batch.length) batches.push(batch);
  }
  return { batches };
}
const chunked = <T,>(rows: T[], size: (row: T) => number) => { const out: T[][] = []; let batch: T[] = [], used = 0; for (const row of rows) { const n = size(row); if (batch.length && (batch.length >= WRITES || used + n > BATCH_BYTES)) { out.push(batch); batch = []; used = 0; } batch.push(row); used += n; } if (batch.length) out.push(batch); return out; };

// Only the importing owner may write to the staging workspace, and only with its import token.
async function staging(ctx: MutationCtx, orgId: Id<"orgs">, token: number) {
  const { user } = await getPrincipal(ctx), org = await ctx.db.get(orgId);
  if (!org || org.importingAt !== token || org.createdBy !== user._id || org.deletingAt) fail("CONFLICT", "This import is no longer running");
  return { org, user };
}
export const importUploadUrl = mutation({ args: {}, handler: async (ctx) => {
  await getPrincipal(ctx);
  if (!await mayCreate(ctx)) fail("FORBIDDEN", "New organisations are invite-only. Ask an organisation owner for an invite link.");
  return ctx.storage.generateUploadUrl();
} });
export const importStart = internalMutation({ args: { name: v.string(), objects: v.array(v.any()), fields: v.array(v.any()) }, handler: async (ctx, args) => {
  const { user } = await getPrincipal(ctx);
  if (!await mayCreate(ctx)) fail("FORBIDDEN", "New organisations are invite-only. Ask an organisation owner for an invite link.");
  const token = Date.now(), orgId = await ctx.db.insert("orgs", { name: args.name, createdBy: user._id, importingAt: token });
  await ctx.db.insert("members", { orgId, userId: user._id, role: "owner" });
  const objects: Record<string, Id<"objects">> = {}, fields: Record<string, Id<"fields">> = {};
  for (const o of args.objects) objects[o.id] = await ctx.db.insert("objects", defined({ orgId, key: o.key, label: o.label, labelPlural: o.labelPlural, icon: o.icon, isStandard: o.isStandard, order: o.order }) as any);
  for (const f of args.fields) {
    const objectId = objects[f.object]!, kind = kindFor(f.type);
    fields[f.id] = await ctx.db.insert("fields", defined({ orgId, objectId, key: f.key, label: f.label, type: f.type, options: f.options, targetObjectId: f.target && objects[f.target], required: f.required, withTime: f.withTime, retired: f.retired, order: f.order, protectedFromAgents: f.protectedFromAgents, slot: kind ? await allocateSlot(ctx, orgId, objectId, kind) : undefined, encoding: 1 }) as any);
  }
  for (const o of args.objects) if (o.titleField !== undefined) await ctx.db.patch(objects[o.id]!, { titleFieldId: fields[args.fields.find(f => f.object === o.id && f.key === o.titleField)!.id] });
  return { orgId, token, objects, fields };
} });
const recordRow = v.object({ objectId: v.id("objects"), ref: v.optional(v.string()), updatedAt: v.number(), title: v.string(), values: v.record(v.string(), v.any()) });
async function linkRows(ctx: MutationCtx, orgId: Id<"orgs">, fields: Doc<"fields">[], recordId: Id<"records">, values: Row) {
  for (const field of fields) if (field.type === "links") for (const to of (values[field._id] as Id<"records">[] | undefined) ?? []) await ctx.db.insert("links", { orgId, fieldId: field._id, fromRecordId: recordId, toRecordId: to });
}
export const importRecords = internalMutation({ args: { orgId: v.id("orgs"), token: v.number(), rows: v.array(recordRow) }, handler: async (ctx, { orgId, token, rows }) => {
  const { user } = await staging(ctx, orgId, token);
  const fields = await ctx.db.query("fields").withIndex("by_object", q => q.eq("orgId", orgId)).collect();
  const ids: Id<"records">[] = [];
  for (const row of rows) {
    const own = fields.filter(f => f.objectId === row.objectId);
    const id = await ctx.db.insert("records", { orgId, objectId: row.objectId, values: row.values, title: row.title, ref: row.ref, updatedAt: row.updatedAt, createdBy: user._id, ...projections(own, row.values) });
    await linkRows(ctx, orgId, own, id, row.values);
    ids.push(id);
  }
  return ids;
} });
// The relations that closed a cycle, once every record on it has an id.
export const importCycles = internalMutation({ args: { orgId: v.id("orgs"), token: v.number(), rows: v.array(v.object({ id: v.id("records"), values: v.record(v.string(), v.any()) })) }, handler: async (ctx, { orgId, token, rows }) => {
  await staging(ctx, orgId, token);
  const fields = await ctx.db.query("fields").withIndex("by_object", q => q.eq("orgId", orgId)).collect();
  for (const row of rows) {
    const record = (await ctx.db.get(row.id))!, own = fields.filter(f => f.objectId === record.objectId), values = { ...record.values, ...row.values };
    await ctx.db.patch(row.id, { values, ...projections(own, values) });
    await linkRows(ctx, orgId, own, row.id, row.values);
  }
} });
// Ids for records that only history mentions: inserted and deleted at once, so events keep a valid record id.
export const importGhosts = internalMutation({ args: { orgId: v.id("orgs"), token: v.number(), objectIds: v.array(v.id("objects")) }, handler: async (ctx, { orgId, token, objectIds }) => {
  const { user } = await staging(ctx, orgId, token);
  const ids: Id<"records">[] = [];
  for (const objectId of objectIds) { const id = await ctx.db.insert("records", { orgId, objectId, values: {}, title: "", createdBy: user._id, updatedAt: 0 }); await ctx.db.delete(id); ids.push(id); }
  return ids;
} });
export const importEvents = internalMutation({ args: { orgId: v.id("orgs"), token: v.number(), rows: v.array(v.any()) }, handler: async (ctx, { orgId, token, rows }) => {
  await staging(ctx, orgId, token);
  for (const row of rows) await ctx.db.insert("events", { ...row, orgId, actor: { kind: "imported", name: String(row.actor.name) } });
} });
export const importPublish = internalMutation({ args: { orgId: v.id("orgs"), token: v.number() }, handler: async (ctx, { orgId, token }) => {
  const { user } = await staging(ctx, orgId, token);
  const objects = await ctx.db.query("objects").withIndex("by_org", q => q.eq("orgId", orgId)).collect();
  await ctx.db.patch(orgId, { importingAt: undefined, authorityFrozenAt: Math.max(Date.now(), ...objects.map(o => o._creationTime)), authorityFrozenKeys: Object.fromEntries(objects.map(o => [o._id, o.key])) });
  await ctx.db.insert("authorityAudit", { orgId, actor: { kind: "user", id: user._id }, action: "workspaceImported", targetId: orgId });
} });
// A failed import leaves nothing behind: the staging workspace goes through the same bounded purge as a deletion.
export const importAbort = internalMutation({ args: { orgId: v.id("orgs"), token: v.number() }, handler: async (ctx, { orgId, token }) => {
  await staging(ctx, orgId, token);
  await ctx.db.patch(orgId, { deletingAt: Date.now() });
  await ctx.scheduler.runAfter(0, internal.workspace.purge, { orgId, step: 0 });
} });

async function stage(ctx: ActionCtx, data: Row, fieldOf: Map<string, Row>) {
  const start = await ctx.runMutation(internal.workspace.importStart, { name: data.workspace.name.trim(), objects: data.objects, fields: data.fields });
  const { orgId, token, objects, fields } = start, records = new Map<string, Id<"records">>();
  try {
    const { batches } = planImport(data, fieldOf);
    const remap = (object: string, values: Row, history: boolean) => Object.fromEntries(Object.entries(values).flatMap(([key, value]) => {
      const f = fieldOf.get(`${object}:${key}`)!, id = (old: string) => records.get(old);
      if (value === null || (f.type !== "lookup" && f.type !== "links")) return [[fields[f.id], value]];
      const mapped = f.type === "lookup" ? id(value) : (value as string[]).map(id);
      // Live values only drop relations that close a cycle (restored by importCycles); history maps every id.
      if (!history && (mapped === undefined || (Array.isArray(mapped) && mapped.includes(undefined)))) return [];
      return [[fields[f.id], mapped]];
    }));
    const byId = new Map<string, Row>(data.records.map((r: Row) => [r.id, r])), titleKey = new Map<string, string>(data.objects.map((o: Row) => [o.id, o.titleField]));
    const title = (r: Row | undefined, depth = 0): string => {
      const key = r && titleKey.get(r.object), value = key === undefined ? undefined : r!.values[key];
      if (value == null) return "";
      return fieldOf.get(`${r!.object}:${key}`)!.type === "lookup" ? (depth < 3 ? title(byId.get(value), depth + 1) : "") : String(value);
    };
    const dropped = new Map<string, string[]>();
    for (const batch of batches) {
      const rows = batch.map(r => { const values = remap(r.object, r.values, false), missing = Object.keys(r.values).filter(key => !(fields[fieldOf.get(`${r.object}:${key}`)!.id]! in values)); if (missing.length) dropped.set(r.id, missing); return defined({ objectId: objects[r.object], ref: r.ref, updatedAt: r.updatedAt, title: title(r), values }); });
      const ids = await ctx.runMutation(internal.workspace.importRecords, { orgId, token, rows: rows as any });
      batch.forEach((r, i) => records.set(r.id, ids[i]!));
    }
    const fixes = [...dropped].map(([old, keys]) => { const r = byId.get(old)!; return { id: records.get(old)!, values: remap(r.object, Object.fromEntries(keys.map(key => [key, r.values[key]])), true) }; });
    for (const rows of chunked(fixes, row => utf8(JSON.stringify(row)))) await ctx.runMutation(internal.workspace.importCycles, { orgId, token, rows });
    // History may name records that were deleted before the export.
    const ghosts = new Map<string, string>();
    for (const e of data.events) for (const [old, object] of [[e.record, e.object], ...[e.before, e.after].flatMap((values: Row | null) => Object.entries(values ?? {}).flatMap(([key, value]) => { const f = fieldOf.get(`${e.object}:${key}`)!; return f.type === "lookup" || f.type === "links" ? (Array.isArray(value) ? value : [value]).filter(Boolean).map(id => [id, f.target ?? e.object]) : []; }))] as [string, string][]) if (!records.has(old) && !ghosts.has(old)) ghosts.set(old, object);
    for (const part of chunked([...ghosts], () => 0)) { const ids = await ctx.runMutation(internal.workspace.importGhosts, { orgId, token, objectIds: part.map(([, object]) => objects[object]!) }); part.forEach(([old], i) => records.set(old, ids[i]!)); }
    // In original order, so history pages in the same order as `at`.
    const events = [...data.events].sort((a: Row, b: Row) => a.at - b.at).map((e: Row) => defined({ at: e.at, actor: { name: e.by }, action: e.action, objectId: objects[e.object], recordId: records.get(e.record), before: e.before && remap(e.object, e.before, true), after: e.after && remap(e.object, e.after, true), reason: e.reason }));
    for (const rows of chunked(events, row => utf8(JSON.stringify(row)))) await ctx.runMutation(internal.workspace.importEvents, { orgId, token, rows });
    await ctx.runMutation(internal.workspace.importPublish, { orgId, token });
    return orgId;
  } catch (error) {
    await ctx.runMutation(internal.workspace.importAbort, { orgId, token });
    throw error;
  }
}
export const importAll = action({ args: { storageId: v.id("_storage") }, handler: async (ctx, { storageId }): Promise<Id<"orgs">> => {
  try {
    const blob = (await ctx.storage.get(storageId)) ?? fail("NOT_FOUND", "Upload the export file first");
    if (blob.size > MAX_IMPORT_BYTES()) fail("VALIDATION", `Import refused: the file is larger than ${mb(MAX_IMPORT_BYTES())}. Larger workspaces are imported by request: shakur@codemyvibe.com.`);
    let data: unknown;
    try { data = JSON.parse(await blob.text()); } catch { fail("VALIDATION", "Import refused: the file is not JSON"); }
    const fieldOf = validate(data), rows = (data as Row).records.length + (data as Row).events.length + (data as Row).records.reduce((n: number, r: Row) => n + Object.entries(r.values).reduce((m, [key, value]) => m + (fieldOf.get(`${r.object}:${key}`)?.type === "links" ? (value as unknown[]).length : 0), 0), 0);
    if (rows > MAX_IMPORT_ROWS()) fail("VALIDATION", `Import refused: the file holds ${rows} records, history entries and links; one import takes up to ${MAX_IMPORT_ROWS()}. Larger workspaces are imported by request: shakur@codemyvibe.com.`);
    return await stage(ctx, data as Row, fieldOf);
  } finally { await ctx.storage.delete(storageId); }
} });

// ---- Deletion ----
// One small write. It needs the exact name, and either an export finished in the last day or the typed phrase.
export const confirmDelete = mutation({ args: { orgId: v.id("orgs"), confirmName: v.string(), withoutExport: v.optional(v.string()) }, handler: async (ctx, { orgId, confirmName, withoutExport }) => {
  const { org } = await requireOwner(ctx, orgId);
  if (org.name !== confirmName) fail("VALIDATION", "Type the workspace name exactly to delete it");
  if (withoutExport !== undefined && withoutExport !== NO_EXPORT) fail("VALIDATION", `Type ${NO_EXPORT} exactly to delete without an export`);
  if (withoutExport === undefined && !(org.exportedAt && Date.now() - org.exportedAt < EXPORT_FRESH_MS)) fail("VALIDATION", `Export the workspace first, or type ${NO_EXPORT}`);
  await ctx.db.patch(orgId, { deletingAt: Date.now() });
  await pauseWork(ctx, orgId);
  await ctx.scheduler.runAfter(0, internal.workspace.purge, { orgId, step: 0 });
} });

// Every table holding workspace rows, in order. A table reached through a parent is deleted with that parent:
// each parent's children go first, then the parent, and each run deletes at most BATCH rows in all.
// workspace.test.ts derives the list of orgId tables from the schema and checks each one empties.
type Node = { table: string; index: string; field?: string; children?: Node[] };
const of = (table: string, index: string, children?: Node[], field?: string): Node => ({ table, index, children, field });
const purgeOrder: Node[] = [
  of("members", "by_org_user"), of("capabilityGrants", "by_agent"), of("agents", "by_org"), of("invites", "by_org"),
  of("safetyTargets", "by_org", [of("integrationReceipts", "by_target", undefined, "targetId")]),
  of("integrationEvents", "by_org_at"), of("integrationOps", "by_org"),
  of("integrationBindings", "by_org", [of("integrationCallbacks", "by_event", undefined, "bindingId"), of("integrationObservations", "by_binding", undefined, "bindingId")]),
  of("integrationConnections", "by_org", [of("integrationCursors", "by_resource", [of("integrationPages", "by_page", undefined, "cursorId"), of("integrationLookups", "by_traversal", undefined, "cursorId")], "connectionId"), of("integrationIntents", "by_logical", undefined, "connectionId")]),
  of("secretReferences", "by_org"), of("consent", "by_recipient"), of("usageBudgets", "by_key", undefined, "key"), of("agentInbox", "by_org_status"), of("suggestions", "by_org_status"),
  of("authorityAudit", "by_org"), of("opsEvents", "by_org"), of("billingEvents", "by_org"),
  of("links", "by_record_any"), of("events", "by_org"), of("records", "by_object"), of("fields", "by_object"), of("objects", "by_org"),
];
// Deletes up to `budget` rows under `key`, children first; a parent goes only once its children are gone.
async function drain(ctx: MutationCtx, node: Node, key: string, budget: number): Promise<number> {
  let deleted = 0;
  for (const row of await (ctx.db.query(node.table as any) as any).withIndex(node.index, (q: any) => q.eq(node.field ?? "orgId", key)).take(budget)) {
    for (const child of node.children ?? []) { deleted += await drain(ctx, child, row._id, budget - deleted); if (deleted >= budget) return deleted; }
    await ctx.db.delete(row._id); deleted += 1;
    if (deleted >= budget) return deleted;
  }
  return deleted;
}
export const BATCH = 200;
// `step` is the cursor carried between runs: tables before it are already empty.
export const purge = internalMutation({ args: { orgId: v.id("orgs"), step: v.optional(v.number()) }, handler: async (ctx, { orgId, step = 0 }) => {
  const org = await ctx.db.get(orgId);
  if (!org?.deletingAt) return;
  for (let i = step; i < purgeOrder.length; i++) {
    if (!await drain(ctx, purgeOrder[i]!, orgId, BATCH)) continue;
    await ctx.scheduler.runAfter(0, internal.workspace.purge, { orgId, step: i });
    return;
  }
  await ctx.db.delete(orgId);
} });

// A purge step that throws ends its chain; the hourly cron starts a fresh one for any unfinished deletion.
export const resumeDeletions = internalMutation({ args: {}, handler: async (ctx) => {
  for await (const org of ctx.db.query("orgs")) if (org.deletingAt) await ctx.scheduler.runAfter(0, internal.workspace.purge, { orgId: org._id, step: 0 });
} });
