import { internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { ConvexError, v } from "convex/values";
import { ownerOf, recordGranted, requireAgent, type Principal } from "./identity";
import { fail } from "./errors";
import { applyChange } from "./lib/applyChange";
import { pageRecords, takeRecords, listedRelated } from "./lib/list";
import { searchRecords } from "./lib/search";
import { visibleInboxItems, visibleSuggestions } from "./authority/pending";
import { daily } from "./today";
import { orgDay } from "./lib/zone";
import { myQueue } from "./lib/queue";
import { instantBound, joined, readable, readableMap, readableValue, resolveValues } from "./lib/values";
import { canPropose, canReadObject, canReadRecordId, canReadRecord, canReadField, requireObjectRead, requireRecordRead, requireQueryField, visibleTitle, projectEvent, paginateIndex, pageList } from "./authority/reads";
import { writable } from "./authority/readonly";
import { canSeeInbox, visibleInbox } from "./authority/inbox";
import { agentGuard } from "./authority/agentGuards";
import { idempotency, remember, replay } from "./lib/idempotency";
import { leadArgs, submitLead } from "./lib/intake";
import { campaignReport as reportOf, emailPreview as previewOf, markReplied as markSendReplied } from "./lib/campaign";
import { blueprint, changeInput, requireLive } from "./lib/metadata";
import { exportBlueprint, rollBack, runBlueprint } from "./lib/blueprint";
import { templates } from "./lib/templates";
import { slotsLeft } from "./lib/slots";
import { agentRow, proposalFor } from "./shapeSuggestions";
import { linksOf } from "./suggestions";
import { reasonFor, summaryOf } from "./batches";
import { archived, forReader, runView } from "./lib/views";
import { dryRun, history } from "./automations";

const keyHash = v.string();
const action = v.union(v.literal("create"), v.literal("update"), v.literal("delete"));
const status = v.union(v.literal("pending"), v.literal("applied"), v.literal("dismissed"), v.literal("conflicted"));
const inboxStatus = v.union(v.literal("pending"), v.literal("resolved"));
// Link deltas add or remove records on a links field against whatever it holds when applied, so concurrent additions survive.
const links = v.optional(v.record(v.string(), v.object({ add: v.optional(v.array(v.string())), remove: v.optional(v.array(v.string())) })));
type Links = Record<string, { add?: string[]; remove?: string[] }>;
type Deltas = Record<string, { add: Id<"records">[]; remove: Id<"records">[] }>;
type Item = { object: Doc<"objects">; fields: Doc<"fields">[] };
type Cache = Map<string, Promise<Item>>;
const memo = (cache: Cache | undefined, key: string, load: () => Promise<Item>) => { if (!cache) return load(); let hit = cache.get(key); if (!hit) cache.set(key, hit = load()); return hit; };

async function objectFor(ctx: any, orgId: Id<"orgs">, key: string, retained = false): Promise<{ object: Doc<"objects">; fields: Doc<"fields">[] }> {
  const object = await ctx.db.query("objects").withIndex("by_org_key", (q: any) => q.eq("orgId", orgId).eq("key", key)).unique() as Doc<"objects"> | null;
  if (!object) fail("NOT_FOUND", "Object not found");
  const fields = await ctx.db.query("fields").withIndex("by_object", (q: any) => q.eq("orgId", orgId).eq("objectId", object._id)).collect() as Doc<"fields">[];
  return { object, fields: fields.filter((field: Doc<"fields">) => retained || !field.retired).sort((a: Doc<"fields">, b: Doc<"fields">) => a.order - b.order) };
}
async function objectForId(ctx: any, orgId: Id<"orgs">, objectId: Id<"objects">, retained = false) {
  const object = await ctx.db.get(objectId) as Doc<"objects"> | null;
  if (!object || object.orgId !== orgId) fail("NOT_FOUND", "Object not found");
  return objectFor(ctx, orgId, object.key, retained);
}

async function recordFor(ctx: any, orgId: Id<"orgs">, idOrRef: string): Promise<Doc<"records">> {
  const id = ctx.db.normalizeId("records", idOrRef);
  const record = ((id && await ctx.db.get(id)) ?? await ctx.db.query("records").withIndex("by_org_ref", (q: any) => q.eq("orgId", orgId).eq("ref", idOrRef.trim().toLowerCase())).unique()) as Doc<"records"> | null;
  if (!record || record.orgId !== orgId) fail("NOT_FOUND", "Record not found");
  return record;
}

async function readableLinks(ctx: any, principal: Principal, visible: Doc<"fields">[], deltas: Deltas) {
  const out: Record<string, { add: unknown; remove: unknown }> = {};
  for (const [id, delta] of Object.entries(deltas)) { const field = visible.find(f => f._id === id); if (field) out[field.key] = { add: await readableValue(ctx, principal, field, delta.add) ?? [], remove: await readableValue(ctx, principal, field, delta.remove) ?? [] }; }
  return out;
}
async function suggestionApi(ctx: any, principal: Principal, suggestion: Doc<"suggestions">) {
  const orgId = principal.org._id;
  const sourceObject = await ctx.db.get(suggestion.change.objectId) as Doc<"objects"> | null;
  const { object, fields } = await objectFor(ctx, orgId, sourceObject?.key ?? "");
  const record = suggestion.change.recordId ? await ctx.db.get(suggestion.change.recordId) : null, agent = await ctx.db.get(suggestion.agentId);
  requireObjectRead(principal, object);
  if (!canReadRecordId(principal, object, suggestion.change.recordId)) fail("NOT_FOUND", "Suggestion not found");
  const visible = fields.filter(f => canReadField(principal, object, f, suggestion.change.recordId));
  const byId = new Map(visible.map((field: Doc<"fields">) => [field._id as string, field]));
  const links = await linksOf(ctx, suggestion._id);
  const conflicts = suggestion.conflicts ? await Promise.all(suggestion.conflicts.filter(conflict => byId.has(conflict.fieldId)).map(async (conflict) => { const field = byId.get(conflict.fieldId); const show = async (value: unknown) => field ? (await readableMap(ctx, principal, visible, { [field._id]: value }))[field.key] : value; return { field: field?.key ?? conflict.fieldId, expected: await show(conflict.expected), actual: await show(conflict.actual) }; })) : undefined;
  return { id: suggestion._id, status: suggestion.status, action: suggestion.change.action, object: object.key, record: record ? { id: record._id, ref: record.ref ?? null, title: await visibleTitle(ctx, principal, record) } : null, values: await readableMap(ctx, principal, visible, suggestion.change.values), before: await readableMap(ctx, principal, visible, suggestion.before), reason: visible.length === fields.length ? suggestion.reason : "", agent: agent?.name ?? null, createdAt: suggestion._creationTime, resolvedAt: suggestion.resolvedAt ?? null, ...(conflicts ? { conflicts } : {}), ...(links ? { links: await readableLinks(ctx, principal, visible, links.links) } : {}) };
}

const scopedIds = (principal: Principal, object: Doc<"objects">) => "agent" in principal ? (principal.capabilities ?? []).flatMap(g => g.scope.kind === "records" && g.scope.objectId === object._id && g.scope.records !== "all" ? g.scope.records : []) : [];
// Delete is possible on the whole object, or on any single record this agent can read and holds a delete grant for.
const canDelete = (principal: Principal, object: Doc<"objects">) => [undefined, ...scopedIds(principal, object)].some(id => canReadRecordId(principal, object, id) && recordGranted(principal, "delete", object, id));

// Modes describe field authority; /me supplies record scopes and lifecycle guards still apply.
function fieldWrite(principal: Principal, object: Doc<"objects">, field: Doc<"fields">, action: "create" | "update") {
  if (field.protectedFromAgents) return "none";
  const scoped = scopedIds(principal, object);
  const records = action === "create" ? [undefined] : [undefined, ...scoped];
  const visible = records.filter(id => canReadRecordId(principal, object, id) && canReadField(principal, object, field, id));
  return visible.some(id => recordGranted(principal, action, object, id, [field._id])) ? "direct" : visible.some(id => canPropose(principal, object, id, [field._id])) ? "propose" : "none";
}

const ownShape = (ctx: any, agent: Doc<"agents">, status?: Doc<"shapeSuggestions">["status"], limit = 1000): Promise<Doc<"shapeSuggestions">[]> => ctx.db.query("shapeSuggestions").withIndex("by_agent", (q: any) => q.eq("orgId", agent.orgId).eq("agentId", agent._id)).order("desc").filter((q: any) => status ? q.eq(q.field("status"), status) : true).take(limit);
// The hosted MCP endpoint checks the key on every message, including ones that call no tool.
export const checkKey = internalQuery({ args: { keyHash }, handler: async (ctx, args) => { await requireAgent(ctx, args.keyHash); return null; } });
const meOf = async (ctx: QueryCtx, principal: Awaited<ReturnType<typeof requireAgent>>) => { const [pendingInbox, pendingSuggestions, pendingShape] = await Promise.all([visibleInboxItems(ctx, principal, "pending"), visibleSuggestions(ctx, principal, "pending"), ownShape(ctx, principal.agent, "pending")]); return { org: { id: principal.org._id, name: principal.org.name }, agent: { id: principal.agent._id, name: principal.agent.name, role: principal.agent.role, grants: principal.agent.grants, readsAllObjects: principal.agent.authorityVersion === 1 && !!principal.agent.readAllObjects, readableObjects: (await ctx.db.query("objects").withIndex("by_org", (q) => q.eq("orgId", principal.org._id)).collect()).sort((a, b) => a.order - b.order).filter((object) => canReadObject(principal, object)).map((object) => object.key), capabilities: (principal.capabilities ?? []).map(g => ({ id: g._id, capability: g.capability, scope: g.scope, mode: g.mode, delegate: g.delegate, expiresAt: g.expiresAt })) }, pendingInbox: pendingInbox.length, pendingSuggestions: pendingSuggestions.length, pendingShapeProposals: pendingShape.length }; };
export const me = internalQuery({ args: { keyHash }, handler: async (ctx, args) => meOf(ctx, await requireAgent(ctx, args.keyHash)) });
// Archived objects are left out unless asked for; their records and links are untouched.
// slotsLeft is shown only to an agent that sees every field, since retired and hidden fields hold slots too.
const objectsOf = async (ctx: QueryCtx, principal: Awaited<ReturnType<typeof requireAgent>>, includeArchived = false) => { const objects = await ctx.db.query("objects").withIndex("by_org", (q) => q.eq("orgId", principal.org._id)).collect(); return Promise.all(objects.filter(object => canReadObject(principal, object) && (includeArchived || !object.archived)).sort((a, b) => a.order - b.order).map(async (object) => { const all = (await ctx.db.query("fields").withIndex("by_object", (q) => q.eq("orgId", principal.org._id).eq("objectId", object._id)).collect()).sort((a, b) => a.order - b.order), readableFields = all.filter((field) => canReadField(principal, object, field)), fields = readableFields.filter((field) => !field.retired), left = slotsLeft(all); return { key: object.key, label: object.label, labelPlural: object.labelPlural, archived: !!object.archived, titleField: fields.find((field) => field._id === object.titleFieldId)?.key ?? null, fields: await Promise.all(fields.map(async (field) => ({ key: field.key, label: field.label, type: field.type, ...(field.options ? { options: field.options } : {}), ...(field.targetObjectId ? { target: (await ctx.db.get(field.targetObjectId))?.key } : {}), required: field.required, indexed: !!field.slot, withTime: !!field.withTime, protectedFromAgents: !!field.protectedFromAgents, write: { create: fieldWrite(principal, object, field, "create"), update: fieldWrite(principal, object, field, "update") } }))), retiredFields: readableFields.filter((field) => field.retired).map((field) => ({ key: field.key, label: field.label, type: field.type })), slotsLeft: readableFields.length === all.length ? { text: left.s, number: left.n, date: left.d, boolean: left.b } : null }; })); };
export const objects = internalQuery({ args: { keyHash, includeArchived: v.optional(v.boolean()) }, handler: async (ctx, args) => objectsOf(ctx, await requireAgent(ctx, args.keyHash), args.includeArchived) });
// Counts are coarse and bounded: at most PROBE rows per object through the same readable listing /records uses
// (so record-scoped agents count their own records), and BUDGET rows for the whole map, in object order.
const PROBE = 51, BUDGET = 600, FEATURES: Record<string, string> = { campaign: "campaigns", email: "emails", post: "posts", invoice: "invoices", bookingPage: "bookingPages", automation: "automations" };
export const map = internalQuery({ args: { keyHash }, handler: async (ctx, args) => {
  const principal = await requireAgent(ctx, args.keyHash), [me, shape, rows] = await Promise.all([meOf(ctx, principal), objectsOf(ctx, principal), ctx.db.query("objects").withIndex("by_org", (q) => q.eq("orgId", principal.org._id)).collect()]);
  const byKey = new Map(rows.map((o) => [o.key, o]));
  let budget = BUDGET;
  const counted: (typeof shape[number] & { count: string })[] = [];
  for (const o of shape) {
    const object = byKey.get(o.key)!;
    if (budget < PROBE) { counted.push({ ...o, count: "unknown" }); continue; }
    const read = (await takeRecords(ctx, principal.org._id, object._id, PROBE, principal)).length;
    budget -= read;
    counted.push({ ...o, count: read === 0 ? "0" : read < PROBE ? "1-50" : "50+" });
  }
  const modes = (o: any, action: "create" | "update") => o.fields.map((f: any) => f.write[action]);
  const direct = counted.flatMap((o) => { const acts: string[] = (["create", "update"] as const).filter((a) => modes(o, a).includes("direct")); if (canDelete(principal, byKey.get(o.key)!)) acts.push("delete"); return acts.length ? [`${o.label} (${acts.join(", ")})`] : []; });
  const propose = counted.filter((o) => ["create", "update"].some((a) => modes(o, a as "create").includes("propose"))).map((o) => o.label);
  const canDo = [
    ...(direct.length ? [`Apply directly with remold_apply_change: ${direct.join(", ")}.`] : []),
    ...(propose.length ? [`Propose changes for a person to approve with remold_propose_change: ${propose.join(", ")}.`] : []),
    "Propose a new field or object with remold_propose_shape.",
    "Read your inbox with remold_inbox.",
  ];
  const features = Object.entries(FEATURES).filter(([key]) => counted.some((o) => o.key === key)).map(([, name]) => name);
  return { org: me.org, agent: me.agent, objects: counted, features, pending: { inbox: me.pendingInbox, suggestions: me.pendingSuggestions, shapeProposals: me.pendingShapeProposals }, canDo };
} });
export const listRecords = internalQuery({ args: { keyHash, object: v.string(), cursor: v.optional(v.string()), limit: v.optional(v.number()), sort: v.optional(v.object({ field: v.string(), direction: v.union(v.literal("asc"), v.literal("desc")) })), filter: v.optional(v.object({ field: v.string(), value: v.any() })), filters: v.optional(v.array(v.object({ field: v.string(), value: v.any() }))), range: v.optional(v.object({ field: v.string(), from: v.optional(v.string()), to: v.optional(v.string()) })) }, handler: async (ctx, args) => {
  const principal = await requireAgent(ctx, args.keyHash), item = await objectFor(ctx, principal.org._id, args.object), byKey = new Map(item.fields.map((field) => [field.key, field]));
  requireObjectRead(principal, item.object);
  const known = (key: string) => { const field = byKey.get(key); if (!field) fail("NOT_FOUND", "Field not found"); requireQueryField(principal, item.object, field); return field; };
  const sort = args.sort ? { fieldId: known(args.sort.field)._id, direction: args.sort.direction } : undefined;
  // Query strings arrive as text; the slot holds the field's real type, so each value is coerced like any agent input.
  const filters = [];
  for (const filter of [...(args.filter ? [args.filter] : []), ...(args.filters ?? [])]) { const field = known(filter.field); filters.push({ fieldId: field._id, value: (await resolveValues(ctx, principal, item.object, item.fields, { [field.key]: filter.value }, undefined, "filter"))[field._id] }); }
  // A bare date as the end of a range means through the end of that day (UTC).
  const bound = (text: string | undefined, end: boolean) => { if (text === undefined) return undefined; const ms = instantBound(text); if (ms === undefined) fail("VALIDATION", "Range bounds must be YYYY-MM-DD or an ISO 8601 time with an offset"); return end && /^\d{4}-\d{2}-\d{2}$/.test(text) ? ms + 86400000 - 1 : ms; };
  // On a with-time field, all-day values match by the calendar date written in each bound, so offset bounds name local days.
  const rangeField = args.range && known(args.range.field), dateOf = (text: string | undefined) => text === undefined ? undefined : instantBound(text.slice(0, 10));
  const range = args.range && rangeField ? { fieldId: rangeField._id, from: bound(args.range.from, false), to: bound(args.range.to, true), ...(rangeField.withTime ? { days: { from: dateOf(args.range.from), to: dateOf(args.range.to) } } : {}) } : undefined;
  const page = await pageRecords(ctx, principal.org._id, item.object._id, { cursor: args.cursor ?? null, numItems: Math.min(Math.max(Math.floor(args.limit ?? 25) || 25, 1), 100) }, sort, { filters, range }, principal);
  return { records: await Promise.all(page.page.filter(record => canReadRecord(principal, item.object, record)).map((record) => readable(ctx, principal, record, item.object, item.fields))), cursor: page.isDone ? null : page.continueCursor };
} });

export const getRecord = internalQuery({ args: { keyHash, idOrRef: v.string(), cursor: v.optional(v.string()), limit: v.optional(v.number()) }, handler: async (ctx, args) => { const principal = await requireAgent(ctx, args.keyHash), record = await recordFor(ctx, principal.org._id, args.idOrRef), item = await objectForId(ctx, principal.org._id, record.objectId); requireRecordRead(principal, item.object, record); const history = await paginateIndex(ctx.db.query("events").withIndex("by_record", (q) => q.eq("orgId", principal.org._id).eq("recordId", record._id)).order("desc"), { cursor: args.cursor ?? null, numItems: Math.min(Math.max(Math.floor(args.limit ?? 20) || 20, 1), 100) }), events = history.page; const byId = new Map(item.fields.map((field) => [field._id, field.key])); return { record: await readable(ctx, principal, record, item.object, item.fields), events: await Promise.all(events.map(async (event) => { const actor = event.actor.kind === "agent" ? await ctx.db.get(event.actor.id as Id<"agents">) : event.actor.kind === "user" ? await ctx.db.get(event.actor.id as Id<"users">) : null; const masked = await projectEvent(ctx, principal, event); const convert = (values: Record<string, unknown> | null) => values && Object.fromEntries(Object.entries(values).map(([id, value]) => [byId.get(id as Id<"fields">) ?? id, value])); return { at: event._creationTime, actor: { kind: event.actor.kind, name: actor?.name ?? event.actor.kind }, action: event.action, before: convert(masked?.before ?? null), after: convert(masked?.after ?? null), reason: masked?.reason ?? null }; })), nextCursor: history.isDone ? null : history.continueCursor }; } });
export const search = internalQuery({ args: { keyHash, q: v.string(), object: v.optional(v.string()), limit: v.optional(v.number()) }, handler: async (ctx, args) => { const principal = await requireAgent(ctx, args.keyHash); const item = args.object ? await objectFor(ctx, principal.org._id, args.object) : null, limit = Math.min(args.limit ?? 10, 100); const records = await searchRecords(ctx, principal, args.q.trim(), item?.object._id, limit); return Promise.all(records.map(async (record) => { const recordItem = item && record.objectId === item.object._id ? item : await objectForId(ctx, principal.org._id, record.objectId); return readable(ctx, principal, record, recordItem.object, recordItem.fields); })); } });
export const related = internalQuery({ args: { keyHash, idOrRef: v.string(), field: v.string() }, handler: async (ctx, args) => { const principal = await requireAgent(ctx, args.keyHash), target = await recordFor(ctx, principal.org._id, args.idOrRef), [objectKey, fieldKey] = args.field.split("."); const targetObject = await ctx.db.get(target.objectId); if (!targetObject) fail("NOT_FOUND"); requireRecordRead(principal, targetObject, target); if (!objectKey || !fieldKey) fail("VALIDATION", "Field must be objectKey.fieldKey"); const item = await objectFor(ctx, principal.org._id, objectKey), field = item.fields.find((value) => value.key === fieldKey); requireObjectRead(principal, item.object); if (field) requireQueryField(principal, item.object, field); if (!field || (field.type !== "lookup" && field.type !== "links") || (field.targetObjectId && field.targetObjectId !== target.objectId)) fail("NOT_FOUND", "Field does not relate to record"); if (field.type === "lookup" && !field.slot) fail("UNINDEXED_FIELD", "Field is not indexed"); let rows = (await listedRelated(ctx, principal, item.object, field, target._id))?.slice(0, 100); if (!rows) { if (field.type === "links") { const links = await ctx.db.query("links").withIndex("by_to", (q) => q.eq("orgId", principal.org._id).eq("fieldId", field._id).eq("toRecordId", target._id)).take(100); rows = (await Promise.all(links.map(link => ctx.db.get(link.fromRecordId)))).filter((r): r is Doc<"records"> => r !== null && canReadRecord(principal, item.object, r)); } else { const name = `${field.slot!.kind}${field.slot!.index}`; rows = (await (ctx.db.query("records") as any).withIndex(`by_${name}`, (q: any) => q.eq("orgId", principal.org._id).eq("objectId", item.object._id).eq(name, target._id)).take(100) as Doc<"records">[]).filter(r => canReadRecord(principal, item.object, r)); } } return Promise.all(rows.map((record) => readable(ctx, principal, record, item.object, item.fields))); } });
export const today = internalQuery({ args: { keyHash }, handler: async (ctx, args) => {
  const principal = await requireAgent(ctx, args.keyHash), { zone, day, start, end } = await orgDay(ctx, principal.org._id, Date.now());
  const selected = await daily(ctx, principal, zone, day, 8);
  const show = async (records: Doc<"records">[]) => Promise.all(records.map(async record => { const item = await objectForId(ctx, principal.org._id, record.objectId); return readable(ctx, principal, record, item.object, item.fields); }));
  const [tasks, quiet, mine, blocked] = await Promise.all([show(selected.tasks), show(selected.quiet), show(selected.mine), show(selected.waiting.map(w => w.record))]);
  return { day: { zone, date: new Date(day).toISOString().slice(0, 10), startsAt: new Date(start).toISOString(), endsAt: new Date(end + 1).toISOString() }, mine, waiting: blocked.map((task, i) => ({ task, waitingOn: selected.waiting[i]!.on.map(b => ({ id: b._id, title: b.title })) })), tasks, quiet };
} });
// The agent's own ready tasks, in working order, a page at a time.
export const myTasks = internalQuery({ args: { keyHash, cursor: v.optional(v.string()), limit: v.optional(v.number()) }, handler: async (ctx, args) => {
  const principal = await requireAgent(ctx, args.keyHash), item = await objectFor(ctx, principal.org._id, "task").catch(() => null);
  if (!item) return { records: [], cursor: null };
  const { mine } = await myQueue(ctx, principal, { object: item.object, byKey: new Map(item.fields.map(f => [f.key, f])) }, principal.agent._id);
  const page = pageList(mine, { cursor: args.cursor ?? null, numItems: Math.min(Math.max(Math.floor(args.limit ?? 25) || 25, 1), 100) });
  return { records: await Promise.all(page.page.map(record => readable(ctx, principal, record, item.object, item.fields))), cursor: page.isDone ? null : page.continueCursor };
} });

const isEmpty = (value: unknown) => value === null || value === undefined;

// Finds what a change targets before anything is resolved, so a grant can be
// refused, and a bad object or record reported, without touching values.
type ChangeInput = { action: "create" | "update" | "delete"; object?: string; record?: string; values?: Record<string, unknown>; links?: Links };
async function targetOf(ctx: any, orgId: Id<"orgs">, args: ChangeInput, cache?: Cache) {
  if (args.action === "create") { if (!args.object || !(args.values || args.links)) fail("VALIDATION", "Create needs object and values"); const key = args.object; return { item: await memo(cache, `key:${key}`, () => objectFor(ctx, orgId, key)), record: null as Doc<"records"> | null }; }
  if (!args.record) fail("VALIDATION", "Change needs record");
  const record = await recordFor(ctx, orgId, args.record), item = await memo(cache, `id:${record.objectId}:${args.action === "delete"}`, () => objectForId(ctx, orgId, record.objectId, args.action === "delete"));
  if (args.object && args.object !== item.object.key) fail("NOT_FOUND", "Record does not match object");
  if (args.action === "update" && !(args.values || args.links)) fail("VALIDATION", "Update needs values");
  return { item, record };
}
// Field ids a change names, known before anything is resolved.
const named = (target: { item: Item; record: Doc<"records"> | null }, args: ChangeInput) => args.action === "delete" ? Object.keys(target.record!.values) : [...Object.keys(args.values ?? {}), ...Object.keys(args.links ?? {})].map(key => target.item.fields.find((field: Doc<"fields">) => field.key === key)?._id).filter((id): id is Id<"fields"> => !!id);
async function deltasOf(ctx: any, principal: Principal, item: Item, visible: Doc<"fields">[], input: Links | undefined, values: Record<string, unknown>) {
  const out: Deltas = {};
  for (const [key, delta] of Object.entries(input ?? {})) {
    const field = visible.find(f => f.key === key);
    if (!field || field.type !== "links") fail("VALIDATION", `${key} is not a links field`, { fieldKey: key });
    if (field._id in values) fail("VALIDATION", `${key} is in both values and links`, { fieldKey: key });
    const ids = async (list?: string[]) => list?.length ? [...new Set((await resolveValues(ctx, principal, item.object, [field], { [key]: list }))[field._id] as Id<"records">[])] : [];
    const add = await ids(delta.add), remove = await ids(delta.remove);
    if (add.some(id => remove.includes(id))) fail("VALIDATION", "A record cannot be both added and removed", { fieldKey: key });
    out[field._id] = { add, remove };
  }
  return out;
}
// Resolves values and checks required fields now, so a suggestion a person
// cannot apply is refused at proposal time rather than at their tap.
// `merged` is what the record would hold: values plus each link delta applied to the current links.
async function proposed(ctx: any, principal: Principal, args: ChangeInput, target: { item: Item; record: Doc<"records"> | null }) {
  const { item, record } = target;
  requireObjectRead(principal, item.object);
  if (record) requireRecordRead(principal, item.object, record);
  else if (!canReadRecordId(principal, item.object)) fail('FORBIDDEN', 'All-record scope required to create');
  const visible = item.fields.filter(field => canReadField(principal, item.object, field, record?._id));
  if (args.action === 'delete' && Object.keys(record!.values).some(id => !visible.some(field => field._id === id))) fail('VALIDATION', 'Deletion includes restricted fields');
  const values = args.action === "delete" ? {} : await resolveValues(ctx, principal, item.object, visible, args.values ?? {});
  const links = args.action === "delete" ? {} : await deltasOf(ctx, principal, item, visible, args.links, values);
  const merged: Record<string, unknown> = { ...values };
  for (const [id, delta] of Object.entries(links)) merged[id] = joined(record?.values[id], delta);
  for (const field of item.fields) if (field.required && (args.action === "create" || field._id in merged) && isEmpty(merged[field._id])) fail("VALIDATION", `${field.label} is required`, { fieldKey: field.key });
  const before = args.action === "create" ? {} : args.action === "delete" ? record!.values : Object.fromEntries(Object.keys(merged).map((id) => [id, record!.values[id] ?? null]));
  return { item, record, values, links, merged, before };
}
export const propose = internalMutation({ args: { keyHash, action, object: v.optional(v.string()), record: v.optional(v.string()), values: v.optional(v.record(v.string(), v.any())), links, reason: v.string(), inboxId: v.optional(v.id("agentInbox")), idempotency }, handler: async (ctx, args) => { const principal = await requireAgent(ctx, args.keyHash); const prior = await replay(ctx, principal.agent._id, args.idempotency); if (prior) { const suggestion = await ctx.db.get(prior.result.id as Id<"suggestions">); if (!suggestion) fail("NOT_FOUND"); return { suggestion: await suggestionApi(ctx, principal, suggestion) }; } await writable(ctx, principal.org._id); const target = await targetOf(ctx, principal.org._id, args); if (args.action === "create") requireLive(target.item.object);
  // Proposal scope is checked before any value is resolved: resolving a lookup by name must not run for an agent that may not propose here.
  const touched = named(target, args);
  // Unreadable objects and records stay 404, like ones that do not exist.
  requireObjectRead(principal, target.item.object); if (target.record) requireRecordRead(principal, target.item.object, target.record);
  if (!canPropose(principal, target.item.object, target.record?._id, touched)) fail("FORBIDDEN", "Proposal scope required");
  const result = await proposed(ctx, principal, args, target); agentGuard(principal, result.item.object, result.item.fields, result.record, args.action === "delete" ? "delete" : result.merged); if (!canPropose(principal, result.item.object, result.record?._id, Object.keys(args.action === "delete" ? result.before : result.merged))) fail("FORBIDDEN", "Proposal scope required"); if (args.inboxId) { const inbox = await ctx.db.get(args.inboxId); if (!inbox || !canSeeInbox(principal, inbox)) fail("NOT_FOUND", "Inbox item not found"); } const id = await ctx.db.insert("suggestions", { orgId: principal.org._id, agentId: principal.agent._id, authorityEpoch: principal.agent.authorityEpoch ?? 0, status: "pending", change: { action: args.action, objectId: result.item.object._id, ...(result.record ? { recordId: result.record._id } : {}), values: result.values }, ...(result.record ? { recordId: result.record._id } : {}), before: result.before, reason: args.reason, ...(args.inboxId ? { inboxId: args.inboxId } : {}) }); if (Object.keys(result.links).length) await ctx.db.insert("suggestionLinks", { orgId: principal.org._id, suggestionId: id, links: result.links }); await remember(ctx, principal.org._id, principal.agent._id, args.idempotency, { id }); return { suggestion: await suggestionApi(ctx, principal, await ctx.db.get(id) as Doc<"suggestions">) }; } });
// ADR 002 replay returns the original result, projected through the caller's current
// authority. The stored copy holds only values the caller could read at write time; on
// replay a gone record is 404, an unreadable one 403, newly hidden fields are dropped
// and nothing outside the original response is added. The marker still blocks a rewrite.
type Original = { recordId: Id<"records">; eventId: Id<"events"> | null; deleted: boolean; values?: Record<string, unknown>; title?: string; updatedAt?: number };
function original(record: Doc<"records">, fields: Doc<"fields">[], response: { title: string; values: Record<string, unknown> }, eventId: Id<"events"> | null): Original {
  const keys = Object.keys(response.values), ids = new Set(fields.filter((field) => keys.includes(field.key)).map((field) => field._id as string));
  return { recordId: record._id, eventId, deleted: false, values: Object.fromEntries(Object.entries(record.values).filter(([id]) => ids.has(id))), title: response.title, updatedAt: record.updatedAt };
}
async function replayedChange(ctx: any, principal: Principal, stored: Original) {
  if (stored.deleted) return { record: null, eventId: stored.eventId };
  const current = await ctx.db.get(stored.recordId) as Doc<"records"> | null, item = current && await objectForId(ctx, principal.org._id, current.objectId);
  if (!current || !item) fail("NOT_FOUND", "The original record no longer exists");
  if (!canReadRecord(principal, item.object, current)) fail("FORBIDDEN", "The original change is no longer readable with this key");
  const projected = await readable(ctx, principal, { ...current, values: stored.values ?? {}, title: stored.title ?? "", updatedAt: stored.updatedAt ?? current.updatedAt }, item.object, item.fields);
  return { record: { ...projected, title: projected.title && (stored.title ?? "") }, eventId: stored.eventId };
}
export const change = internalMutation({ args: { keyHash, action, object: v.optional(v.string()), record: v.optional(v.string()), values: v.optional(v.record(v.string(), v.any())), links, reason: v.string(), idempotency }, handler: async (ctx, args) => { const principal = await requireAgent(ctx, args.keyHash), prior = await replay(ctx, principal.agent._id, args.idempotency); if (prior) return replayedChange(ctx, principal, prior.result); const target = await targetOf(ctx, principal.org._id, args); if (!recordGranted(principal, args.action, target.item.object, target.record?._id)) fail("FORBIDDEN", `No grant for ${args.action}:${target.item.object.key}. Propose it instead.`); const result = await proposed(ctx, principal, args, target); const change = args.action === "create" ? { action: "create" as const, orgId: principal.org._id, objectId: result.item.object._id, values: result.merged, reason: args.reason } : args.action === "update" ? { action: "update" as const, orgId: principal.org._id, recordId: result.record!._id, values: result.merged, reason: args.reason } : { action: "delete" as const, orgId: principal.org._id, recordId: result.record!._id, reason: args.reason }; const applied = await applyChange(ctx, principal, change); const record = args.action === "delete" ? null : await ctx.db.get(applied.recordId); const response = record ? await readable(ctx, principal, record, result.item.object, result.item.fields) : null; await remember(ctx, principal.org._id, principal.agent._id, args.idempotency, record && response ? original(record, result.item.fields, response, applied.eventId) : { recordId: applied.recordId, eventId: applied.eventId, deleted: true }); return { record: response, eventId: applied.eventId }; } });
export const intakeLead = internalMutation({ args: { keyHash, ...leadArgs, idempotency }, handler: async (ctx, { keyHash, idempotency, ...lead }) => submitLead(ctx, await requireAgent(ctx, keyHash, "intake"), lead, idempotency) });

export const listSuggestions = internalQuery({ args: { keyHash, status: v.optional(status) }, handler: async (ctx, args) => { const principal = await requireAgent(ctx, args.keyHash); return Promise.all((await visibleSuggestions(ctx, principal, args.status ?? "pending", 100)).map((suggestion) => suggestionApi(ctx, principal, suggestion))); } });
async function inboxApi(ctx: any, principal: Principal, original: Doc<"agentInbox">) { const item = await visibleInbox(ctx, principal, original); if (!item) fail("NOT_FOUND", "Inbox item not found"); const source = item.from.kind === "agent" ? await ctx.db.get(item.from.id as Id<"agents">) : await ctx.db.get(item.from.id as Id<"users">); return { id: item._id, text: item.text, source: item.source, from: { kind: item.from.kind, name: source?.name ?? null }, status: item.status, createdAt: item._creationTime, resolvedAt: item.resolvedAt ?? null, note: item.note ?? null, suggestionId: item.suggestionId ?? null, recordId: item.recordId ?? null }; }
export const inbox = internalQuery({ args: { keyHash, status: v.optional(inboxStatus) }, handler: async (ctx, args) => { const principal = await requireAgent(ctx, args.keyHash); return Promise.all((await visibleInboxItems(ctx, principal, args.status ?? "pending", 100)).map((item) => inboxApi(ctx, principal, item))); } });
export const inboxAdd = internalMutation({ args: { keyHash, text: v.string(), source: v.optional(v.string()), idempotency }, handler: async (ctx, args) => { const principal = await requireAgent(ctx, args.keyHash); const prior = await replay(ctx, principal.agent._id, args.idempotency); if (prior) { const item = await ctx.db.get(prior.result.id as Id<"agentInbox">); if (!item) fail("NOT_FOUND"); return inboxApi(ctx, principal, item); } await writable(ctx, principal.org._id); if (!args.text.trim()) fail("VALIDATION", "Inbox text is required"); const id = await ctx.db.insert("agentInbox", { orgId: principal.org._id, text: args.text.trim(), source: args.source ?? "api", from: { kind: "agent", id: principal.agent._id }, status: "pending", audience: "author" }); await remember(ctx, principal.org._id, principal.agent._id, args.idempotency, { id }); return inboxApi(ctx, principal, await ctx.db.get(id) as Doc<"agentInbox">); } });
export const inboxResolve = internalMutation({ args: { keyHash, id: v.id("agentInbox"), note: v.optional(v.string()), suggestionId: v.optional(v.id("suggestions")), recordId: v.optional(v.id("records")), idempotency }, handler: async (ctx, args) => { const principal = await requireAgent(ctx, args.keyHash), item = await ctx.db.get(args.id), prior = await replay(ctx, principal.agent._id, args.idempotency); if (prior) { if (!item) fail("NOT_FOUND"); return inboxApi(ctx, principal, item); } await writable(ctx, principal.org._id); if (!item || !canSeeInbox(principal, item)) fail("NOT_FOUND", "Inbox item not found"); if (item.status !== "pending") fail("CONFLICT", "Already resolved"); if (args.suggestionId) { const suggestion = await ctx.db.get(args.suggestionId); const object = suggestion ? await ctx.db.get(suggestion.change.objectId) : null; if (!suggestion || !object || !canReadRecordId(principal, object, suggestion.change.recordId)) fail("NOT_FOUND", "Suggestion not found"); } if (args.recordId) { const record = await ctx.db.get(args.recordId); const object = record ? await ctx.db.get(record.objectId) : null; if (!record || !object || !canReadRecord(principal, object, record)) fail("NOT_FOUND", "Record not found"); } await ctx.db.patch(item._id, { status: "resolved", resolvedBy: principal.agent._id, resolvedAt: Date.now(), ...(args.note !== undefined ? { note: args.note } : {}), ...(args.suggestionId ? { suggestionId: args.suggestionId } : {}), ...(args.recordId ? { recordId: args.recordId } : {}) }); await remember(ctx, principal.org._id, principal.agent._id, args.idempotency, { id: item._id }); return inboxApi(ctx, principal, await ctx.db.get(item._id) as Doc<"agentInbox">); } });

// Campaign email for agents: the report, a preview for one person, and marking a reply.
export const campaignReport = internalQuery({ args: { keyHash, idOrRef: v.string() }, handler: async (ctx, args) => { const principal = await requireAgent(ctx, args.keyHash); return reportOf(ctx, principal, await recordFor(ctx, principal.org._id, args.idOrRef)); } });
export const emailPreview = internalQuery({ args: { keyHash, idOrRef: v.string(), person: v.optional(v.string()) }, handler: async (ctx, args) => { const principal = await requireAgent(ctx, args.keyHash); const person = args.person ? await recordFor(ctx, principal.org._id, args.person) : undefined; return previewOf(ctx, principal, await recordFor(ctx, principal.org._id, args.idOrRef), person?._id); } });
export const markReplied = internalMutation({ args: { keyHash, id: v.string(), idempotency }, handler: async (ctx, args) => { const principal = await requireAgent(ctx, args.keyHash), prior = await replay(ctx, principal.agent._id, args.idempotency); if (prior) return prior.result; return remember(ctx, principal.org._id, principal.agent._id, args.idempotency, await markSendReplied(ctx, principal, args.id)); } });
// Bookings on the pages this key can read, by page and start time. People's names and
// addresses only as far as the key may read the person.
export const bookings = internalQuery({ args: { keyHash, page: v.optional(v.string()), from: v.optional(v.string()), to: v.optional(v.string()) }, handler: async (ctx, args) => {
  const principal = await requireAgent(ctx, args.keyHash), item = await objectFor(ctx, principal.org._id, "bookingPage"), person = await objectFor(ctx, principal.org._id, "person").catch(() => null);
  requireObjectRead(principal, item.object);
  const bound = (text: string | undefined, end: boolean) => { if (text === undefined) return undefined; const ms = instantBound(text); if (ms === undefined) fail("VALIDATION", "from and to must be YYYY-MM-DD or an ISO 8601 time with an offset"); return end && /^\d{4}-\d{2}-\d{2}$/.test(text) ? ms + 86400000 - 1 : ms; };
  const from = bound(args.from, false) ?? 0, to = bound(args.to, true) ?? Number.MAX_SAFE_INTEGER;
  const page = args.page ? await recordFor(ctx, principal.org._id, args.page) : null;
  if (page) { if (page.objectId !== item.object._id) fail("NOT_FOUND", "Booking page not found"); requireRecordRead(principal, item.object, page); }
  const rows = page ? await ctx.db.query("bookings").withIndex("by_page_start", (q) => q.eq("pageRecordId", page._id).gte("start", from).lte("start", to)).take(500) : await ctx.db.query("bookings").withIndex("by_org_start", (q) => q.eq("orgId", principal.org._id).gte("start", from).lte("start", to)).take(500);
  const field = (key: string) => person?.fields.find((f) => f.key === key), out = [];
  for (const b of rows) {
    const pageRecord = page ?? await ctx.db.get(b.pageRecordId);
    if (!pageRecord || !canReadRecord(principal, item.object, pageRecord)) continue;
    const who = person ? await ctx.db.get(b.personRecordId) : null, readable = !!who && !!person && canReadRecord(principal, person.object, who);
    const show = (key: string) => readable && !!field(key) && canReadField(principal, person!.object, field(key)!, who!._id);
    out.push({ id: b._id, page: { id: pageRecord._id, ref: pageRecord.ref ?? null }, person: readable ? { id: who!._id, ref: who!.ref ?? null } : null, name: show("name") ? b.name : null, email: show("email") ? b.email : null, start: new Date(b.start).toISOString(), end: new Date(b.end).toISOString(), status: b.status, paid: !!b.paidAt, amountMinor: b.amountMinor ?? null, currency: b.currency ?? null, campaign: b.campaignRecordId ?? null, sendId: b.sendId ?? null, attention: b.attention ?? null });
  }
  return { bookings: out };
} });
// Automations for agents: what one did (run history) and what it would do for a record, writing nothing.
export const automationRuns = internalQuery({ args: { keyHash, idOrRef: v.string() }, handler: async (ctx, args) => { const principal = await requireAgent(ctx, args.keyHash); return history(ctx, principal, await recordFor(ctx, principal.org._id, args.idOrRef)); } });
export const automationTest = internalQuery({ args: { keyHash, idOrRef: v.string(), record: v.optional(v.string()) }, handler: async (ctx, args) => { const principal = await requireAgent(ctx, args.keyHash); return dryRun(ctx, principal, await recordFor(ctx, principal.org._id, args.idOrRef), args.record ? await recordFor(ctx, principal.org._id, args.record) : null); } });
const shapeArgs = { ...changeInput, reason: v.string(), blueprint: v.optional(blueprint) };
export const proposeShape = internalMutation({ args: { keyHash, ...shapeArgs, idempotency }, handler: async (ctx, { keyHash, idempotency, ...input }) => { const principal = await requireAgent(ctx, keyHash); const prior = await replay(ctx, principal.agent._id, idempotency); if (prior) { const proposal = await ctx.db.get(prior.result.id as Id<"shapeSuggestions">); if (!proposal) fail("NOT_FOUND"); return { proposal: await agentRow(ctx, proposal) }; } await writable(ctx, principal.org._id); const change = await proposalFor(ctx, principal, input); const id = await ctx.db.insert("shapeSuggestions", { orgId: principal.org._id, agentId: principal.agent._id, authorityEpoch: principal.agent.authorityEpoch ?? 0, change, reason: input.reason, status: "pending" }); await remember(ctx, principal.org._id, principal.agent._id, idempotency, { id }); return { proposal: await agentRow(ctx, (await ctx.db.get(id))!) }; } });
export const shapeProposals = internalQuery({ args: { keyHash, status: v.optional(v.union(v.literal("pending"), v.literal("applied"), v.literal("dismissed"), v.literal("failed"))) }, handler: async (ctx, args) => { const principal = await requireAgent(ctx, args.keyHash); return { proposals: await Promise.all((await ownShape(ctx, principal.agent, args.status, 100)).map((row) => agentRow(ctx, row))) }; } });
// Blueprints: the built-in ones, this workspace's shape as one, and the trial run that checks
// a proposed one with the very code that applies it, then rolls it back (lib/blueprint.ts).
export const blueprints = internalQuery({ args: { keyHash }, handler: async (ctx, args) => { await requireAgent(ctx, args.keyHash); return { blueprints: templates }; } });
export const currentBlueprint = internalQuery({ args: { keyHash }, handler: async (ctx, args) => ({ blueprint: await exportBlueprint(ctx, await requireAgent(ctx, args.keyHash)) }) });
export const trialBlueprint = internalMutation({ args: { keyHash, blueprint }, handler: async (ctx, args) => {
  const principal = await requireAgent(ctx, args.keyHash);
  if (principal.agent.role !== "admin") fail("FORBIDDEN", "Only an admin agent can propose shape changes");
  await writable(ctx, principal.org._id);
  rollBack(await runBlueprint(ctx, principal, args.blueprint, { person: await ownerOf(ctx, principal.org._id), records: true, agent: principal.agent }));
} });

// Batches: up to MAX_BATCH changes under one reason, each checked exactly like a single
// proposal (or, when direct, a single granted change). One bad item refuses the batch.
export const MAX_BATCH = 1000;
const batchChange = v.object({ action, object: v.optional(v.string()), record: v.optional(v.string()), values: v.optional(v.record(v.string(), v.any())), links });
type Row = { action: ChangeInput["action"]; item: Item; record: Doc<"records"> | null; values: Record<string, unknown>; links: Deltas; before: Record<string, unknown> };

const counted = (n: number, object: Doc<"objects">) => `${n} ${n === 1 ? object.label : object.labelPlural}`;
const listed = (parts: string[]) => parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
const verbs = { create: "Create", update: "Update", delete: "Delete" } as const;
// One line a person can approve from: "Update Stage on 140 Opportunities", "Add 60 People to {record}".
// {record} is filled in per reader (summaryOf), so a title is shown only to those who may read it.
async function summarize(ctx: any, rows: Row[]) {
  const first = rows[0]!, label = (row: Row, id: string) => row.item.fields.find((f) => f._id === id)?.label ?? "a field";
  const deltas = Object.entries(first.links);
  if (rows.length === 1 && first.action === "update" && !Object.keys(first.values).length && deltas.length === 1) {
    const [id, { add, remove }] = deltas[0]!, field = first.item.fields.find((f) => f._id === id)!, target = field.targetObjectId ? await ctx.db.get(field.targetObjectId) as Doc<"objects"> | null : null;
    const name = (n: number) => target ? counted(n, target) : `${n} ${field.label}`, title = "{record}";
    if (!remove.length) return `Add ${name(add.length)} to ${title}`;
    if (!add.length) return `Remove ${name(remove.length)} from ${title}`;
    return `Add ${add.length} and remove ${remove.length} ${target?.labelPlural ?? field.label} on ${title}`;
  }
  const groups = new Map<string, { action: Row["action"]; object: Doc<"objects">; count: number; fields: Set<string> }>();
  for (const row of rows) {
    const key = `${row.action}:${row.item.object._id}`, group = groups.get(key) ?? { action: row.action, object: row.item.object, count: 0, fields: new Set<string>() };
    group.count++; for (const id of [...Object.keys(row.values), ...Object.keys(row.links)]) group.fields.add(label(row, id)); groups.set(key, group);
  }
  const all = [...groups.values()];
  if (all.length === 1 && all[0]!.action === "update") { const names = [...all[0]!.fields]; return `Update ${names.length <= 2 ? listed(names) : `${names.length} fields`} on ${counted(all[0]!.count, all[0]!.object)}`; }
  if (all.length <= 3 && all.every((g) => g.action === first.action)) return `${verbs[first.action]} ${listed(all.map((g) => counted(g.count, g.object)))}`;
  if (all.length <= 3) return listed(all.map((g, i) => `${i ? verbs[g.action].toLowerCase() : verbs[g.action]} ${counted(g.count, g.object)}`));
  return `${rows.length} changes across ${new Set(all.map((g) => g.object._id)).size} objects`;
}

const progressOf = (batch: Doc<"batches">) => ({ done: batch.applied + batch.conflicted + batch.failed, applied: batch.applied, conflicted: batch.conflicted, failed: batch.failed });
// No delete impact here: it counts links from records the agent may not be able to read.
const batchApi = async (ctx: any, principal: Principal, batch: Doc<"batches">) => ({ id: batch._id, status: batch.status, mode: batch.mode, summary: await summaryOf(ctx, principal, batch), reason: await reasonFor(ctx, principal, batch), total: batch.total, counts: batch.counts, progress: progressOf(batch), createdAt: batch._creationTime, resolvedAt: batch.resolvedAt ?? null, ...(batch.error ? { error: batch.error } : {}) });

export const proposeBatch = internalMutation({ args: { keyHash, reason: v.string(), changes: v.array(batchChange), direct: v.optional(v.boolean()), idempotency }, handler: async (ctx, args) => {
  const principal = await requireAgent(ctx, args.keyHash), orgId = principal.org._id, direct = !!args.direct, prior = await replay(ctx, principal.agent._id, args.idempotency);
  // A replayed direct batch that stopped or lost its driver is picked up again; the driver never applies an item twice.
  if (prior) { const batch = await ctx.db.get(prior.result.batchId as Id<"batches">); if (!batch) fail("NOT_FOUND", "Batch not found"); if (batch.mode === "direct" && (batch.status === "applying" || batch.status === "stopped")) { await ctx.db.patch(batch._id, { status: "applying", error: undefined }); await ctx.scheduler.runAfter(0, internal.batches.drive, { batchId: batch._id }); } return { batch: await batchApi(ctx, principal, (await ctx.db.get(batch._id))!) }; }
  await writable(ctx, orgId);
  if (args.changes.length < 1 || args.changes.length > MAX_BATCH) fail("VALIDATION", `A batch needs 1 to ${MAX_BATCH} changes`);
  const cache: Cache = new Map(), seen = new Set<string>(), rows: Row[] = [], errors: { index: number; code: string; message: string }[] = [];
  for (const [index, input] of args.changes.entries()) {
    try {
      const target = await targetOf(ctx, orgId, input, cache), { object } = target.item, recordId = target.record?._id;
      requireObjectRead(principal, object); if (target.record) requireRecordRead(principal, object, target.record);
      if (input.action === "create") requireLive(object);
      if (recordId) { if (seen.has(recordId)) fail("VALIDATION", "This record already has a change earlier in the batch"); seen.add(recordId); }
      const allowed = (ids: string[]) => direct ? recordGranted(principal, input.action, object, recordId, ids) : canPropose(principal, object, recordId, ids);
      const refuse = () => fail("FORBIDDEN", direct ? `No grant for ${input.action}:${object.key}. Propose it instead.` : "Proposal scope required");
      if (!allowed(named(target, input))) refuse();
      const result = await proposed(ctx, principal, input, target);
      agentGuard(principal, object, result.item.fields, result.record, input.action === "delete" ? "delete" : result.merged);
      if (!allowed(Object.keys(input.action === "delete" ? result.before : result.merged))) refuse();
      rows.push({ action: input.action, item: result.item, record: result.record, values: result.values, links: result.links, before: result.before });
    } catch (error) {
      const data = error instanceof ConvexError ? error.data as { code?: string; message?: string } : null;
      if (!data?.code) throw error;
      errors.push({ index, code: data.code, message: data.message ?? data.code });
    }
  }
  // The batch takes the first failing item's code, so its status matches what that change alone would get.
  if (errors.length) fail(errors[0]!.code as any, errors.length === 1 ? `Change ${errors[0]!.index}: ${errors[0]!.message}. Nothing was saved.` : `${errors.length} changes cannot be made, starting with change ${errors[0]!.index}: ${errors[0]!.message}. Nothing was saved.`, { items: errors });
  const counts = { create: 0, update: 0, delete: 0 }; for (const row of rows) counts[row.action]++;
  const touched = new Set<Id<"fields">>(); for (const row of rows) for (const id of Object.keys(row.action === "delete" ? row.before : { ...row.values, ...row.links })) touched.add(id as Id<"fields">);
  const batchId = await ctx.db.insert("batches", { orgId, agentId: principal.agent._id, authorityEpoch: principal.agent.authorityEpoch ?? 0, mode: direct ? "direct" : "proposal", status: direct ? "applying" : "pending", reason: args.reason, summary: await summarize(ctx, rows), ...(rows.length === 1 && rows[0]!.record ? { subjectId: rows[0]!.record._id } : {}), total: rows.length, counts, impact: 0, ...(counts.delete && !direct ? { counting: true } : {}), objectIds: [...new Set(rows.map((row) => row.item.object._id))], fieldIds: [...touched], applied: 0, conflicted: 0, failed: 0, ...(direct ? { progressAt: Date.now() } : {}) });
  for (const [index, row] of rows.entries()) await ctx.db.insert("batchItems", { orgId, batchId, index, action: row.action, objectId: row.item.object._id, ...(row.record ? { recordId: row.record._id } : {}), values: row.values, ...(Object.keys(row.links).length ? { links: row.links } : {}), before: row.before, status: "queued" });
  if (direct) await ctx.scheduler.runAfter(0, internal.batches.drive, { batchId });
  // Counted after submit, a hundred deletes per transaction, so a large batch stays inside one mutation's time limit.
  else if (counts.delete) await ctx.scheduler.runAfter(0, internal.batches.countDrive, { batchId, run: 0 });
  await remember(ctx, orgId, principal.agent._id, args.idempotency, { batchId });
  return { batch: await batchApi(ctx, principal, (await ctx.db.get(batchId))!) };
} });

// The submitting agent reads its batch and a page of items, projected through what it may read now.
export const batchStatus = internalQuery({ args: { keyHash, id: v.string(), cursor: v.optional(v.string()), limit: v.optional(v.number()) }, handler: async (ctx, args) => {
  const principal = await requireAgent(ctx, args.keyHash), id = ctx.db.normalizeId("batches", args.id), batch = id ? await ctx.db.get(id) : null;
  if (!batch || batch.orgId !== principal.org._id || batch.agentId !== principal.agent._id) fail("NOT_FOUND", "Batch not found");
  const page = await paginateIndex(ctx.db.query("batchItems").withIndex("by_batch", (q) => q.eq("batchId", batch._id)), { cursor: args.cursor ?? null, numItems: Math.min(Math.max(Math.floor(args.limit ?? 50) || 50, 1), 100) });
  const items = await Promise.all(page.page.map(async (item: Doc<"batchItems">) => {
    const { object, fields } = await objectForId(ctx, principal.org._id, item.objectId), record = item.recordId ? await ctx.db.get(item.recordId) : null;
    const readableRecord = !!record && canReadRecord(principal, object, record), visible = fields.filter((f) => canReadField(principal, object, f, item.recordId));
    const show = async (fieldId: string, value: unknown) => { const field = visible.find((f) => f._id === fieldId); return field ? (await readableValue(ctx, principal, field, value)) ?? null : null; };
    const conflicts = item.conflicts && await Promise.all(item.conflicts.filter((c) => c.fieldId === "*" || visible.some((f) => f._id === c.fieldId)).map(async (c) => ({ field: visible.find((f) => f._id === c.fieldId)?.key ?? "*", expected: await show(c.fieldId, c.expected), actual: await show(c.fieldId, c.actual) })));
    return { index: item.index, action: item.action, object: object.key, record: item.recordId ? { id: item.recordId, ...(readableRecord ? { ref: record.ref ?? null, title: await visibleTitle(ctx, principal, record) } : {}) } : null, values: await readableMap(ctx, principal, visible, item.values), ...(item.links ? { links: await readableLinks(ctx, principal, visible, item.links) } : {}), status: item.status, ...(item.error ? { error: item.error } : {}), ...(conflicts ? { conflicts } : {}) };
  }));
  return { batch: await batchApi(ctx, principal, batch), items, nextCursor: page.isDone ? null : page.continueCursor };
} });

// Saved views for agents: the shared ones, by key, as far as the key may read. A view
// that filters or sorts by a field the key cannot read is listed as not usable.
async function viewApi(ctx: any, principal: Principal, object: Doc<"objects">, view: Doc<"views">) {
  const { spec, fields, blocked, dropped, createdBy } = await forReader(ctx, principal, object, view), key = (id: Id<"fields">) => fields.get(id)!.key;
  return { id: view._id, object: object.key, name: view.name, layout: spec.layout, columns: spec.columns.map(key), filters: spec.filters.map((f) => ({ field: key(f.fieldId), value: f.value })), range: spec.range ? { field: key(spec.range.fieldId), ...(spec.range.from ? { from: spec.range.from } : {}), ...(spec.range.to ? { to: spec.range.to } : {}), ...(spec.range.relative ? { relative: spec.range.relative } : {}) } : null, sort: spec.sort ? { field: key(spec.sort.fieldId), direction: spec.sort.direction } : null, groupBy: spec.groupFieldId ? key(spec.groupFieldId) : null, dateField: spec.dateFieldId ? key(spec.dateFieldId) : null, pinned: !!view.pinned, createdBy, usable: !blocked, dropped, updatedAt: view.updatedAt };
}
async function sharedView(ctx: any, principal: Principal, id: string) {
  const viewId = ctx.db.normalizeId("views", id), view = viewId ? await ctx.db.get(viewId) as Doc<"views"> | null : null, object = view ? await ctx.db.get(view.objectId) as Doc<"objects"> | null : null;
  if (!view || !object || view.orgId !== principal.org._id || view.ownerId || archived(object) || !canReadObject(principal, object)) fail("NOT_FOUND", "View not found");
  return { view, object };
}
export const views = internalQuery({ args: { keyHash, object: v.optional(v.string()) }, handler: async (ctx, args) => {
  const principal = await requireAgent(ctx, args.keyHash), only = args.object === undefined ? undefined : (await objectFor(ctx, principal.org._id, args.object)).object;
  const objects = (await ctx.db.query("objects").withIndex("by_org", (q) => q.eq("orgId", principal.org._id)).collect()).filter((o) => !archived(o) && canReadObject(principal, o) && (!only || o._id === only._id)).sort((a, b) => a.order - b.order);
  if (only && !objects.length) fail("NOT_FOUND", "Object not found");
  const out = [];
  for (const object of objects) for (const view of (await ctx.db.query("views").withIndex("by_object", (q) => q.eq("orgId", principal.org._id).eq("objectId", object._id)).collect()).filter((view) => !view.ownerId).sort((a, b) => a.order - b.order || a._creationTime - b._creationTime)) out.push(await viewApi(ctx, principal, object, view));
  return { views: out };
} });
// Runs a shared view with the key's own read access. tz names the zone its dates are read in (default UTC).
export const viewRecords = internalQuery({ args: { keyHash, id: v.string(), cursor: v.optional(v.string()), limit: v.optional(v.number()), tz: v.optional(v.string()) }, handler: async (ctx, args) => {
  const principal = await requireAgent(ctx, args.keyHash), { view, object } = await sharedView(ctx, principal, args.id);
  const { spec, page } = await runView(ctx, principal, view, { cursor: args.cursor ?? null, numItems: Math.min(Math.max(Math.floor(args.limit ?? 25) || 25, 1), 100) }, args.tz);
  const fields = (await objectForId(ctx, principal.org._id, object._id)).fields, columns = new Set(fields.filter((f) => spec.columns.includes(f._id)).map((f) => f.key));
  const records = await Promise.all(page.page.filter((record) => canReadRecord(principal, object, record)).map(async (record) => { const full = await readable(ctx, principal, record, object, fields); return columns.size ? { ...full, values: Object.fromEntries(Object.entries(full.values).filter(([key]) => columns.has(key))) } : full; }));
  return { view: await viewApi(ctx, principal, object, view), records, cursor: page.isDone ? null : page.continueCursor };
} });
