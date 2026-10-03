import { internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { recordGranted, requireAgent, type Principal } from "./identity";
import { fail } from "./errors";
import { applyChange } from "./lib/applyChange";
import { pageRecords, takeRecords, listedRelated } from "./lib/list";
import { searchRecords } from "./lib/search";
import { visibleInboxItems, visibleSuggestions } from "./authority/pending";
import { daily } from "./today";
import { orgDay } from "./lib/zone";
import { myQueue } from "./lib/queue";
import { instantBound, readable, readableMap, resolveValues } from "./lib/values";
import { canPropose, canReadObject, canReadRecordId, canReadRecord, canReadField, requireObjectRead, requireRecordRead, requireQueryField, visibleTitle, projectEvent, paginateIndex, pageList } from "./authority/reads";
import { writable } from "./authority/readonly";
import { canSeeInbox, visibleInbox } from "./authority/inbox";
import { agentGuard } from "./authority/agentGuards";
import { idempotency, remember, replay } from "./lib/idempotency";
import { leadArgs, submitLead } from "./lib/intake";
import { campaignReport as reportOf, emailPreview as previewOf, markReplied as markSendReplied } from "./lib/campaign";
import { option, requireLive } from "./lib/metadata";
import { slotsLeft } from "./lib/slots";
import { agentRow, proposalFor } from "./shapeSuggestions";
import { archived, forReader, runView } from "./lib/views";
import { dryRun, history } from "./automations";

const keyHash = v.string();
const action = v.union(v.literal("create"), v.literal("update"), v.literal("delete"));
const status = v.union(v.literal("pending"), v.literal("applied"), v.literal("dismissed"), v.literal("conflicted"));
const inboxStatus = v.union(v.literal("pending"), v.literal("resolved"));

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

async function suggestionApi(ctx: any, principal: Principal, suggestion: Doc<"suggestions">) {
  const orgId = principal.org._id;
  const sourceObject = await ctx.db.get(suggestion.change.objectId) as Doc<"objects"> | null;
  const { object, fields } = await objectFor(ctx, orgId, sourceObject?.key ?? "");
  const record = suggestion.change.recordId ? await ctx.db.get(suggestion.change.recordId) : null, agent = await ctx.db.get(suggestion.agentId);
  requireObjectRead(principal, object);
  if (!canReadRecordId(principal, object, suggestion.change.recordId)) fail("NOT_FOUND", "Suggestion not found");
  const visible = fields.filter(f => canReadField(principal, object, f, suggestion.change.recordId));
  const byId = new Map(visible.map((field: Doc<"fields">) => [field._id as string, field]));
  const conflicts = suggestion.conflicts ? await Promise.all(suggestion.conflicts.filter(conflict => byId.has(conflict.fieldId)).map(async (conflict) => { const field = byId.get(conflict.fieldId); const show = async (value: unknown) => field ? (await readableMap(ctx, principal, visible, { [field._id]: value }))[field.key] : value; return { field: field?.key ?? conflict.fieldId, expected: await show(conflict.expected), actual: await show(conflict.actual) }; })) : undefined;
  return { id: suggestion._id, status: suggestion.status, action: suggestion.change.action, object: object.key, record: record ? { id: record._id, ref: record.ref ?? null, title: await visibleTitle(ctx, principal, record) } : null, values: await readableMap(ctx, principal, visible, suggestion.change.values), before: await readableMap(ctx, principal, visible, suggestion.before), reason: visible.length === fields.length ? suggestion.reason : "", agent: agent?.name ?? null, createdAt: suggestion._creationTime, resolvedAt: suggestion.resolvedAt ?? null, ...(conflicts ? { conflicts } : {}) };
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
async function targetOf(ctx: any, orgId: Id<"orgs">, args: { action: "create" | "update" | "delete"; object?: string; record?: string; values?: Record<string, unknown> }) {
  if (args.action === "create") { if (!args.object || !args.values) fail("VALIDATION", "Create needs object and values"); return { item: await objectFor(ctx, orgId, args.object), record: null as Doc<"records"> | null }; }
  if (!args.record) fail("VALIDATION", "Change needs record");
  const record = await recordFor(ctx, orgId, args.record), item = await objectForId(ctx, orgId, record.objectId, args.action === "delete");
  if (args.object && args.object !== item.object.key) fail("NOT_FOUND", "Record does not match object");
  if (args.action === "update" && !args.values) fail("VALIDATION", "Update needs values");
  return { item, record };
}
// Resolves values and checks required fields now, so a suggestion a person
// cannot apply is refused at proposal time rather than at their tap.
async function proposed(ctx: any, principal: Principal, args: { action: "create" | "update" | "delete"; values?: Record<string, unknown> }, target: { item: { object: Doc<"objects">; fields: Doc<"fields">[] }; record: Doc<"records"> | null }) {
  const { item, record } = target;
  requireObjectRead(principal, item.object);
  if (record) requireRecordRead(principal, item.object, record);
  else if (!canReadRecordId(principal, item.object)) fail('FORBIDDEN', 'All-record scope required to create');
  const visible = item.fields.filter(field => canReadField(principal, item.object, field, record?._id));
  if (args.action === 'delete' && Object.keys(record!.values).some(id => !visible.some(field => field._id === id))) fail('VALIDATION', 'Deletion includes restricted fields');
  const values = args.action === "delete" ? {} : await resolveValues(ctx, principal, item.object, visible, args.values ?? {});
  for (const field of item.fields) if (field.required && (args.action === "create" || field._id in values) && isEmpty(values[field._id])) fail("VALIDATION", `${field.label} is required`, { fieldKey: field.key });
  const before = args.action === "create" ? {} : args.action === "delete" ? record!.values : Object.fromEntries(Object.keys(values).map((id) => [id, record!.values[id] ?? null]));
  return { item, record, values, before };
}
export const propose = internalMutation({ args: { keyHash, action, object: v.optional(v.string()), record: v.optional(v.string()), values: v.optional(v.record(v.string(), v.any())), reason: v.string(), inboxId: v.optional(v.id("agentInbox")), idempotency }, handler: async (ctx, args) => { const principal = await requireAgent(ctx, args.keyHash); const prior = await replay(ctx, principal.agent._id, args.idempotency); if (prior) { const suggestion = await ctx.db.get(prior.result.id as Id<"suggestions">); if (!suggestion) fail("NOT_FOUND"); return { suggestion: await suggestionApi(ctx, principal, suggestion) }; } await writable(ctx, principal.org._id); const target = await targetOf(ctx, principal.org._id, args); if (args.action === "create") requireLive(target.item.object);
  // Proposal scope is checked before any value is resolved: resolving a lookup by name must not run for an agent that may not propose here.
  const touched = args.action === "delete" ? Object.keys(target.record!.values) : Object.keys(args.values ?? {}).map(key => target.item.fields.find((field: Doc<"fields">) => field.key === key)?._id).filter((id): id is Id<"fields"> => !!id);
  // Unreadable objects and records stay 404, like ones that do not exist.
  requireObjectRead(principal, target.item.object); if (target.record) requireRecordRead(principal, target.item.object, target.record);
  if (!canPropose(principal, target.item.object, target.record?._id, touched)) fail("FORBIDDEN", "Proposal scope required");
  const result = await proposed(ctx, principal, args, target); agentGuard(principal, result.item.object, result.item.fields, result.record, args.action === "delete" ? "delete" : result.values); if (!canPropose(principal, result.item.object, result.record?._id, Object.keys(args.action === "delete" ? result.before : result.values))) fail("FORBIDDEN", "Proposal scope required"); if (args.inboxId) { const inbox = await ctx.db.get(args.inboxId); if (!inbox || !canSeeInbox(principal, inbox)) fail("NOT_FOUND", "Inbox item not found"); } const id = await ctx.db.insert("suggestions", { orgId: principal.org._id, agentId: principal.agent._id, authorityEpoch: principal.agent.authorityEpoch ?? 0, status: "pending", change: { action: args.action, objectId: result.item.object._id, ...(result.record ? { recordId: result.record._id } : {}), values: result.values }, ...(result.record ? { recordId: result.record._id } : {}), before: result.before, reason: args.reason, ...(args.inboxId ? { inboxId: args.inboxId } : {}) }); await remember(ctx, principal.org._id, principal.agent._id, args.idempotency, { id }); return { suggestion: await suggestionApi(ctx, principal, await ctx.db.get(id) as Doc<"suggestions">) }; } });
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
export const change = internalMutation({ args: { keyHash, action, object: v.optional(v.string()), record: v.optional(v.string()), values: v.optional(v.record(v.string(), v.any())), reason: v.string(), idempotency }, handler: async (ctx, args) => { const principal = await requireAgent(ctx, args.keyHash), prior = await replay(ctx, principal.agent._id, args.idempotency); if (prior) return replayedChange(ctx, principal, prior.result); const target = await targetOf(ctx, principal.org._id, args); if (!recordGranted(principal, args.action, target.item.object, target.record?._id)) fail("FORBIDDEN", `No grant for ${args.action}:${target.item.object.key}. Propose it instead.`); const result = await proposed(ctx, principal, args, target); const change = args.action === "create" ? { action: "create" as const, orgId: principal.org._id, objectId: result.item.object._id, values: result.values, reason: args.reason } : args.action === "update" ? { action: "update" as const, orgId: principal.org._id, recordId: result.record!._id, values: result.values, reason: args.reason } : { action: "delete" as const, orgId: principal.org._id, recordId: result.record!._id, reason: args.reason }; const applied = await applyChange(ctx, principal, change); const record = args.action === "delete" ? null : await ctx.db.get(applied.recordId); const response = record ? await readable(ctx, principal, record, result.item.object, result.item.fields) : null; await remember(ctx, principal.org._id, principal.agent._id, args.idempotency, record && response ? original(record, result.item.fields, response, applied.eventId) : { recordId: applied.recordId, eventId: applied.eventId, deleted: true }); return { record: response, eventId: applied.eventId }; } });
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
// Automations for agents: what one did (run history) and what it would do for a record, writing nothing.
export const automationRuns = internalQuery({ args: { keyHash, idOrRef: v.string() }, handler: async (ctx, args) => { const principal = await requireAgent(ctx, args.keyHash); return history(ctx, principal, await recordFor(ctx, principal.org._id, args.idOrRef)); } });
export const automationTest = internalQuery({ args: { keyHash, idOrRef: v.string(), record: v.optional(v.string()) }, handler: async (ctx, args) => { const principal = await requireAgent(ctx, args.keyHash); return dryRun(ctx, principal, await recordFor(ctx, principal.org._id, args.idOrRef), args.record ? await recordFor(ctx, principal.org._id, args.record) : null); } });
const fieldInput = { key: v.string(), label: v.string(), type: v.string(), options: v.optional(v.array(option)), target: v.optional(v.string()), withTime: v.optional(v.boolean()), required: v.optional(v.boolean()), indexed: v.optional(v.boolean()) };
const viewInput = { name: v.optional(v.string()), layout: v.optional(v.string()), columns: v.optional(v.array(v.string())), filters: v.optional(v.array(v.object({ field: v.string(), value: v.any() }))), range: v.optional(v.object({ field: v.string(), from: v.optional(v.string()), to: v.optional(v.string()), relative: v.optional(v.string()) })), sort: v.optional(v.object({ field: v.string(), direction: v.union(v.literal("asc"), v.literal("desc")) })), groupBy: v.optional(v.string()), dateField: v.optional(v.string()), pinned: v.optional(v.boolean()) };
const shapeArgs = { ...viewInput, kind: v.string(), reason: v.string(), object: v.optional(v.string()), field: v.optional(v.string()), key: v.optional(v.string()), label: v.optional(v.string()), labelPlural: v.optional(v.string()), icon: v.optional(v.string()), type: v.optional(v.string()), options: v.optional(v.array(option)), target: v.optional(v.string()), withTime: v.optional(v.boolean()), required: v.optional(v.boolean()), indexed: v.optional(v.boolean()), fields: v.optional(v.array(v.object(fieldInput))), order: v.optional(v.array(v.string())) };
export const proposeShape = internalMutation({ args: { keyHash, ...shapeArgs, idempotency }, handler: async (ctx, { keyHash, idempotency, ...input }) => { const principal = await requireAgent(ctx, keyHash); const prior = await replay(ctx, principal.agent._id, idempotency); if (prior) { const proposal = await ctx.db.get(prior.result.id as Id<"shapeSuggestions">); if (!proposal) fail("NOT_FOUND"); return { proposal: await agentRow(ctx, proposal) }; } await writable(ctx, principal.org._id); const change = await proposalFor(ctx, principal, input); const id = await ctx.db.insert("shapeSuggestions", { orgId: principal.org._id, agentId: principal.agent._id, authorityEpoch: principal.agent.authorityEpoch ?? 0, change, reason: input.reason, status: "pending" }); await remember(ctx, principal.org._id, principal.agent._id, idempotency, { id }); return { proposal: await agentRow(ctx, (await ctx.db.get(id))!) }; } });
export const shapeProposals = internalQuery({ args: { keyHash, status: v.optional(v.union(v.literal("pending"), v.literal("applied"), v.literal("dismissed"), v.literal("failed"))) }, handler: async (ctx, args) => { const principal = await requireAgent(ctx, args.keyHash); return { proposals: await Promise.all((await ownShape(ctx, principal.agent, args.status, 100)).map((row) => agentRow(ctx, row))) }; } });

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
