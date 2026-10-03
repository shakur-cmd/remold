import { internalAction, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { requireMember, requireWriter, type AgentMembership, type Membership, type Principal } from "./identity";
import { fail } from "./errors";
import { applyChange } from "./lib/applyChange";
import { joined } from "./lib/values";
import { staleFields } from "./lib/conflicts";
import { validGrants } from "./authority/grants";
import { canReadField, canReadRecord, listedRecordIds, paginateIndex, scopes, visibleTitle } from "./authority/reads";
import { unrestrictedHuman } from "./authority/inbox";

// Items per transaction. A chunk that throws is retried one item per transaction, so
// one bad item fails alone and nothing is half-applied.
const CHUNK = 25;
const status = v.union(v.literal("pending"), v.literal("applying"), v.literal("stopped"), v.literal("done"), v.literal("dismissed"));
const itemStatus = v.union(v.literal("queued"), v.literal("applied"), v.literal("conflicted"), v.literal("failed"));
const paused = (agent: Doc<"agents"> | null, batch: Doc<"batches">) => !agent || agent.revokedAt !== undefined || (agent.state !== undefined && agent.state !== "active") || (agent.authorityEpoch ?? 0) !== batch.authorityEpoch;
const progressOf = (batch: Doc<"batches">) => ({ done: batch.applied + batch.conflicted + batch.failed, applied: batch.applied, conflicted: batch.conflicted, failed: batch.failed });
const fieldsOf = (ctx: QueryCtx, orgId: Id<"orgs">, objectId: Id<"objects">) => ctx.db.query("fields").withIndex("by_object", (q) => q.eq("orgId", orgId).eq("objectId", objectId)).collect();

// A person sees a batch only with every record of every object it touches and, on all
// those records, every field it writes, so its summary, reason and preview hide nothing
// from them. The same test gates apply: a member who cannot write all of it cannot apply any of it.
const everywhere = (principal: Principal, object: Doc<"objects">, field: Doc<"fields">) => canReadField(principal, object, field) && scopes(principal, object).some((s) => s.records === "all" && (s.fields === "all" || s.fields.includes(field._id)));
async function visible(ctx: QueryCtx, principal: Principal, batch: Doc<"batches">) {
  for (const id of batch.objectIds) { const object = await ctx.db.get(id); if (!object || listedRecordIds(principal, object) !== null) return false; }
  for (const id of batch.fieldIds) { const field = await ctx.db.get(id), object = field && await ctx.db.get(field.objectId); if (field && (!object || !everywhere(principal, object, field))) return false; }
  return true;
}
// Free text can say anything, so like a single suggestion's reason it is shown only to a
// reader who sees every field of every object the batch touches, on every record; others get "".
export async function reasonFor(ctx: QueryCtx, principal: Principal, batch: Doc<"batches">) {
  for (const id of batch.objectIds) {
    const object = await ctx.db.get(id);
    if (!object || (await fieldsOf(ctx, batch.orgId, id)).some((field) => !everywhere(principal, object, field))) return "";
  }
  return batch.reason;
}
// The summary names a record as {record}; each reader gets the title they may see.
export async function summaryOf(ctx: QueryCtx, principal: Principal, batch: Doc<"batches">) {
  if (!batch.subjectId) return batch.summary;
  const record = await ctx.db.get(batch.subjectId), object = record && await ctx.db.get(record.objectId);
  return batch.summary.replace("{record}", (record && object && canReadRecord(principal, object, record) ? await visibleTitle(ctx, principal, record) : "") || "a record");
}
async function visibleBatch(ctx: QueryCtx, principal: Principal, orgId: Id<"orgs">, batchId: Id<"batches">) {
  const batch = await ctx.db.get(batchId);
  if (!batch || batch.orgId !== orgId || !await visible(ctx, principal, batch)) fail("NOT_FOUND", "Batch not found");
  return batch;
}

export const list = query({ args: { orgId: v.id("orgs"), status: v.optional(status) }, handler: async (ctx, args) => {
  const principal = await requireMember(ctx, args.orgId), rows = [];
  for (const batch of await ctx.db.query("batches").withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", args.status ?? "pending")).order("desc").take(50)) {
    if (!await visible(ctx, principal, batch)) continue;
    const agent = await ctx.db.get(batch.agentId);
    // Delete impact counts links from records anywhere, so only a reader who sees everything gets it.
    rows.push({ _id: batch._id, status: batch.status, mode: batch.mode, summary: await summaryOf(ctx, principal, batch), reason: await reasonFor(ctx, principal, batch), total: batch.total, counts: batch.counts, impact: unrestrictedHuman(principal) ? batch.impact : null, impactPartial: !!batch.impactPartial, counting: !!batch.counting, countError: batch.countError ?? null, progress: progressOf(batch), agentName: agent?.name ?? null, paused: (batch.status === "pending" || batch.status === "stopped") && paused(agent, batch), createdAt: batch._creationTime, progressAt: batch.progressAt ?? null, resolvedAt: batch.resolvedAt ?? null, error: batch.error ?? null });
  }
  return rows;
} });

// One page of a batch's items for the review table: each change as before and after, link deltas as titles.
export const items = query({ args: { orgId: v.id("orgs"), batchId: v.id("batches"), status: v.optional(itemStatus), paginationOpts: paginationOptsValidator }, handler: async (ctx, args) => {
  const principal = await requireMember(ctx, args.orgId), batch = await visibleBatch(ctx, principal, args.orgId, args.batchId);
  const source = args.status ? ctx.db.query("batchItems").withIndex("by_batch_status", (q) => q.eq("batchId", batch._id).eq("status", args.status!)) : ctx.db.query("batchItems").withIndex("by_batch", (q) => q.eq("batchId", batch._id));
  const page = await paginateIndex(source, args.paginationOpts), loaded = new Map<string, { object: Doc<"objects">; fields: Doc<"fields">[] }>();
  const shape = async (objectId: Id<"objects">) => { let hit = loaded.get(objectId); if (!hit) { const object = (await ctx.db.get(objectId))!; hit = { object, fields: await fieldsOf(ctx, args.orgId, objectId) }; loaded.set(objectId, hit); } return hit; };
  const titles = async (ids: Id<"records">[]) => Promise.all(ids.map(async (id) => { const record = await ctx.db.get(id), object = record && await ctx.db.get(record.objectId); return record && object && canReadRecord(principal, object, record) ? (await visibleTitle(ctx, principal, record)) || "Untitled" : "Hidden record"; }));
  return { ...page, page: await Promise.all(page.page.map(async (item: Doc<"batchItems">) => {
    const { object, fields } = await shape(item.objectId), byId = new Map(fields.map((f) => [f._id as string, f])), record = item.recordId ? await ctx.db.get(item.recordId) : null;
    const gone = object.titleFieldId && typeof item.before[object.titleFieldId] === "string" ? item.before[object.titleFieldId] as string : null;
    return {
      _id: item._id, index: item.index, action: item.action, status: item.status, error: item.error ?? null, impact: unrestrictedHuman(principal) ? item.impact ?? null : null,
      // A conflict may name a field the batch never touched; only fields this reader sees on every record are shown.
      conflicts: item.conflicts?.flatMap((c) => c.fieldId === "*" ? [{ fieldId: "*", expected: null, actual: null }] : byId.has(c.fieldId) && everywhere(principal, object, byId.get(c.fieldId)!) ? [c] : []) ?? null,
      objectKey: object.key, objectLabel: object.label, recordId: item.recordId ?? null, recordTitle: record ? await visibleTitle(ctx, principal, record) : gone,
      changes: item.action === "delete" ? [] : Object.entries(item.values).map(([id, after]) => ({ fieldId: id, label: byId.get(id)?.label ?? "Field", field: byId.get(id) ?? null, before: item.before[id] ?? null, after })),
      links: await Promise.all(Object.entries(item.links ?? {}).map(async ([id, delta]) => ({ fieldId: id, label: byId.get(id)?.label ?? "Field", add: await titles(delta.add), remove: await titles(delta.remove) }))),
    };
  })) };
} });

// Apply all, or resume a batch that stopped or lost its driver. The person who taps it
// is the actor for every item applied from then on.
export const apply = mutation({ args: { orgId: v.id("orgs"), batchId: v.id("batches") }, handler: async (ctx, args) => {
  const member = await requireWriter(ctx, args.orgId), batch = await visibleBatch(ctx, member, args.orgId, args.batchId);
  if (batch.status === "done" || batch.status === "dismissed") return { status: "already" as const, current: batch.status };
  if (batch.counting) fail("CONFLICT", "Still counting what the deletes would clear. Try again in a moment.");
  if (batch.countError) fail("CONFLICT", "Could not count what the deletes would clear. Retry the count first.");
  if (paused(await ctx.db.get(batch.agentId), batch)) fail("FORBIDDEN", "This agent's access changed since it asked; dismiss the batch");
  await ctx.db.patch(batch._id, { status: "applying", error: undefined, progressAt: Date.now(), ...(batch.mode === "proposal" ? { approvedBy: member.user._id, approverEpoch: member.member.authorityEpoch ?? 0 } : {}), ...(batch.status === "pending" ? { resolvedBy: member.user._id } : {}) });
  await ctx.scheduler.runAfter(0, internal.batches.drive, { batchId: batch._id });
  return { status: "applying" as const };
} });

// Dismissing a stopped batch leaves what it applied and drops the rest.
export const dismiss = mutation({ args: { orgId: v.id("orgs"), batchId: v.id("batches") }, handler: async (ctx, args) => {
  const member = await requireMember(ctx, args.orgId), batch = await visibleBatch(ctx, member, args.orgId, args.batchId);
  if (batch.status !== "pending" && batch.status !== "stopped") return { status: "already" as const };
  await ctx.db.patch(batch._id, { status: "dismissed", resolvedBy: member.user._id, resolvedAt: Date.now() });
  return { status: "dismissed" as const };
} });

type Actors = { agent: AgentMembership; approver?: Membership } | { stop: string };
// A proposal writes like an approved suggestion: the agent's authority and limits (also on
// reference cleanup) plus the approver's, with the approver named in history. A direct batch
// writes as the agent. Either losing access, or the workspace going read only, stops the batch.
async function actorsFor(ctx: MutationCtx, batch: Doc<"batches">): Promise<Actors> {
  const org = await ctx.db.get(batch.orgId), doc = await ctx.db.get(batch.agentId);
  if (!org || !doc) return { stop: "The agent no longer exists" };
  if (org.flags?.readonly) return { stop: "Workspace is read only" };
  const agent: AgentMembership = { agent: doc, org, capabilities: await validGrants(ctx, doc), actor: { kind: "agent", id: doc._id } };
  if (paused(doc, batch)) return { stop: "This agent's access changed since it asked. Dismiss the rest of the batch." };
  if (batch.mode === "direct") return { agent };
  const user = batch.approvedBy && await ctx.db.get(batch.approvedBy), member = batch.approvedBy && await ctx.db.query("members").withIndex("by_org_user", (q) => q.eq("orgId", batch.orgId).eq("userId", batch.approvedBy!)).unique();
  if (!user || !member || (member.authorityEpoch ?? 0) !== batch.approverEpoch) return { stop: "The approver's access changed. Apply again to continue." };
  return { agent, approver: { user, member, org, actor: { kind: "user", id: user._id } } };
}

// Skips an item whose record changed in any field it touches (any field, for a delete)
// since review. Link deltas never conflict: they apply to the links as they are now.
async function applyItem(ctx: MutationCtx, batch: Doc<"batches">, actors: Exclude<Actors, { stop: string }>, item: Doc<"batchItems">) {
  const record = item.recordId ? await ctx.db.get(item.recordId) : null;
  const conflicted = async (conflicts: { fieldId: string; expected: unknown; actual: unknown }[]) => { await ctx.db.patch(item._id, { status: "conflicted", conflicts }); return "conflicted" as const; };
  if (item.action !== "create" && (!record || record.orgId !== batch.orgId)) return conflicted([{ fieldId: "*", expected: item.before, actual: null }]);
  const conflicts = item.action === "create" ? [] : staleFields(item.action, record!, item.before, Object.keys(item.values));
  if (conflicts.length) return conflicted(conflicts);
  const values: Record<string, unknown> = { ...item.values };
  for (const [id, delta] of Object.entries(item.links ?? {})) values[id] = joined(record?.values[id], delta);
  const change = item.action === "create" ? { action: "create" as const, orgId: batch.orgId, objectId: item.objectId, values, reason: batch.reason } : item.action === "update" ? { action: "update" as const, orgId: batch.orgId, recordId: record!._id, values, reason: batch.reason } : { action: "delete" as const, orgId: batch.orgId, recordId: record!._id, reason: batch.reason };
  const result = await applyChange(ctx, actors.agent, change, actors.approver ? { approvedBy: actors.approver, actor: actors.approver.actor } : {});
  await ctx.db.patch(item._id, { status: "applied", recordId: result.recordId, ...(result.eventId ? { eventId: result.eventId } : {}) });
  return "applied" as const;
}

// One transaction: the next queued items (or exactly one), applied or skipped. Items are
// marked in the same transaction as their write, so a repeated or concurrent step never applies one twice.
export const step = internalMutation({ args: { batchId: v.id("batches"), size: v.number(), itemId: v.optional(v.id("batchItems")) }, handler: async (ctx, args) => {
  const batch = await ctx.db.get(args.batchId);
  if (!batch || batch.status !== "applying") return { done: true };
  const actors = await actorsFor(ctx, batch);
  if ("stop" in actors) { await ctx.db.patch(batch._id, { status: "stopped", error: actors.stop, progressAt: Date.now() }); return { done: true }; }
  const one = args.itemId && await ctx.db.get(args.itemId);
  const items = args.itemId ? (one && one.batchId === batch._id && one.status === "queued" ? [one] : []) : await ctx.db.query("batchItems").withIndex("by_batch_status", (q) => q.eq("batchId", batch._id).eq("status", "queued")).take(Math.min(Math.max(Math.floor(args.size), 1), 100));
  if (!items.length) { if (!args.itemId) await ctx.db.patch(batch._id, { status: "done", resolvedAt: Date.now(), progressAt: Date.now() }); return { done: !args.itemId }; }
  const tally = { applied: 0, conflicted: 0 };
  for (const item of items) tally[await applyItem(ctx, batch, actors, item)]++;
  await ctx.db.patch(batch._id, { applied: batch.applied + tally.applied, conflicted: batch.conflicted + tally.conflicted, progressAt: Date.now() });
  return { done: false };
} });

export const next = internalQuery({ args: { batchId: v.id("batches") }, handler: async (ctx, args) => (await ctx.db.query("batchItems").withIndex("by_batch_status", (q) => q.eq("batchId", args.batchId).eq("status", "queued")).first())?._id ?? null });

// An item that still throws on its own is recorded as failed with the reason a person would see.
export const failItem = internalMutation({ args: { itemId: v.id("batchItems"), message: v.string() }, handler: async (ctx, args) => {
  const item = await ctx.db.get(args.itemId), batch = item && await ctx.db.get(item.batchId);
  if (!item || !batch || item.status !== "queued" || batch.status !== "applying") return;
  await ctx.db.patch(item._id, { status: "failed", error: args.message });
  await ctx.db.patch(batch._id, { failed: batch.failed + 1, progressAt: Date.now() });
} });

// Incoming links and lookups a delete would clear. Lookup fields are listed once per batch;
// unindexed ones are scanned once and counted by target.
// Delete impact: incoming links and lookup referrers of each deleted record, counted after
// submit in steps that read at most BUDGET documents each, resuming from a cursor. An
// unindexed lookup is never scanned whole: its source object is read up to SCAN_CAP
// records once per batch, and if there are more the total is shown as "N+".
export const BUDGET = 400, SCAN_CAP = 500;
const cursor = v.object({ phase: v.union(v.literal("scan"), v.literal("items")), field: v.number(), index: v.number(), source: v.number(), after: v.union(v.number(), v.null()) });
type Cursor = typeof cursor.type;
// A Retry starts a new run; steps of an older run (a driver still going) change nothing.
export const count = internalMutation({ args: { batchId: v.id("batches"), run: v.number(), cursor: v.optional(cursor) }, handler: async (ctx, args): Promise<{ done: boolean; cursor?: Cursor }> => {
  const batch = await ctx.db.get(args.batchId);
  if (!batch?.counting || (batch.countRun ?? 0) !== args.run) return { done: true };
  const orgId = batch.orgId, objects = await ctx.db.query("objects").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect();
  const lookups = (await Promise.all(objects.map((o) => fieldsOf(ctx, orgId, o._id)))).flat().filter((f) => f.type === "lookup");
  let c: Cursor = args.cursor ?? { phase: "scan", field: 0, index: -1, source: 0, after: null }, budget = BUDGET, total = 0, partial = false;
  const add = async (item: Doc<"batchItems">, n: number) => { if (!n) return; total += n; await ctx.db.patch(item._id, { impact: ((await ctx.db.get(item._id))!.impact ?? 0) + n }); };
  if (c.phase === "scan") {
    const field = lookups.filter((f) => !f.slot)[c.field];
    if (field) {
      const rows = await ctx.db.query("records").withIndex("by_object", (q) => q.eq("orgId", orgId).eq("objectId", field.objectId)).take(SCAN_CAP + 1);
      for (const record of rows.slice(0, SCAN_CAP)) {
        const to = record.values[field._id], id = typeof to === "string" && to !== record._id ? ctx.db.normalizeId("records", to) : null;
        const item = id && await ctx.db.query("batchItems").withIndex("by_batch_record", (q) => q.eq("batchId", batch._id).eq("recordId", id)).unique();
        if (item?.action === "delete") await add(item, 1);
      }
      partial = rows.length > SCAN_CAP;
      await ctx.db.patch(batch._id, { impact: batch.impact + total, ...(partial ? { impactPartial: true } : {}) });
      return { done: false, cursor: { ...c, field: c.field + 1 } };
    }
    c = { phase: "items", field: 0, index: -1, source: 0, after: null };
  }
  const nextDelete = (after: number) => ctx.db.query("batchItems").withIndex("by_batch", (q) => q.eq("batchId", batch._id).gt("index", after)).filter((q) => q.eq(q.field("action"), "delete")).first();
  let item = c.after === null && c.source === 0 ? await nextDelete(c.index) : (await ctx.db.query("batchItems").withIndex("by_batch", (q) => q.eq("batchId", batch._id).eq("index", c.index)).unique());
  while (budget > 0) {
    if (!item) { await ctx.db.patch(batch._id, { impact: batch.impact + total, counting: false }); return { done: true }; }
    if (c.index !== item.index) { c = { ...c, index: item.index, source: 0, after: null }; await ctx.db.patch(item._id, { impact: 0 }); }
    const record = item.recordId ? await ctx.db.get(item.recordId) : null;
    const sources = record ? [null, ...lookups.filter((f) => f.slot && (!f.targetObjectId || f.targetObjectId === record.objectId))] : [];
    if (c.source >= sources.length) { item = await nextDelete(item.index); c = { ...c, source: 0, after: null }; budget--; continue; }
    const field = sources[c.source], after = c.after ?? -1;
    const rows: { _id: string; _creationTime: number; fromRecordId?: string }[] = field
      ? await (ctx.db.query("records") as any).withIndex(`by_${field.slot!.kind}${field.slot!.index}`, (q: any) => q.eq("orgId", orgId).eq("objectId", field.objectId).eq(`${field.slot!.kind}${field.slot!.index}`, record!._id).gt("_creationTime", after)).take(budget)
      : await ctx.db.query("links").withIndex("by_target_any", (q) => q.eq("orgId", orgId).eq("toRecordId", record!._id).gt("_creationTime", after)).take(budget);
    await add(item, rows.filter((row) => (field ? row._id : row.fromRecordId) !== record!._id).length);
    // Every query costs at least one unit, so items with many empty sources still end a step in time.
    const room = budget; budget -= Math.max(1, rows.length);
    c = rows.length < room ? { ...c, source: c.source + 1, after: null } : { ...c, after: rows.at(-1)!._creationTime };
  }
  await ctx.db.patch(batch._id, { impact: batch.impact + total });
  return { done: false, cursor: c };
} });

// Runs the count steps; a step that throws marks the count failed, and Retry starts over.
export const countDrive = internalAction({ args: { batchId: v.id("batches"), run: v.number() }, handler: async (ctx, { batchId, run }) => {
  let at: Cursor | undefined;
  for (let round = 0; round < 10_000; round++) {
    try { const step = await ctx.runMutation(internal.batches.count, { batchId, run, ...(at ? { cursor: at } : {}) }); if (step.done) return; at = step.cursor; }
    catch { await ctx.runMutation(internal.batches.countFailed, { batchId, run }); return; }
  }
} });
export const countFailed = internalMutation({ args: { batchId: v.id("batches"), run: v.number() }, handler: async (ctx, { batchId, run }) => {
  const batch = await ctx.db.get(batchId);
  if (batch?.counting && (batch.countRun ?? 0) === run) await ctx.db.patch(batchId, { counting: false, countError: "Could not count what deleting would clear" });
} });
// Retry: forget what was counted and count again from the start.
export const recount = mutation({ args: { orgId: v.id("orgs"), batchId: v.id("batches") }, handler: async (ctx, args) => {
  const member = await requireMember(ctx, args.orgId), batch = await visibleBatch(ctx, member, args.orgId, args.batchId);
  if (batch.status !== "pending" || !batch.counts.delete) return { status: "already" as const };
  for (const item of await ctx.db.query("batchItems").withIndex("by_batch", (q) => q.eq("batchId", batch._id)).collect()) if (item.impact !== undefined) await ctx.db.patch(item._id, { impact: undefined });
  const run = (batch.countRun ?? 0) + 1;
  await ctx.db.patch(batch._id, { impact: 0, impactPartial: undefined, counting: true, countRun: run, countError: undefined });
  await ctx.scheduler.runAfter(0, internal.batches.countDrive, { batchId: batch._id, run });
  return { status: "counting" as const };
} });

const messageOf = (error: unknown) => error instanceof ConvexError && typeof (error.data as { message?: unknown })?.message === "string" ? (error.data as { message: string }).message : "Something went wrong";
export const drive = internalAction({ args: { batchId: v.id("batches") }, handler: async (ctx, { batchId }) => {
  let single = 0;
  // Bounded so a broken batch cannot loop forever; a person can resume it.
  for (let round = 0; round < 5000; round++) {
    if (single > 0) {
      const itemId = await ctx.runQuery(internal.batches.next, { batchId });
      single = itemId ? single - 1 : 0;
      if (!itemId) continue;
      try { if ((await ctx.runMutation(internal.batches.step, { batchId, size: 1, itemId })).done) return; }
      catch (error) { await ctx.runMutation(internal.batches.failItem, { itemId, message: messageOf(error) }); }
      continue;
    }
    try { if ((await ctx.runMutation(internal.batches.step, { batchId, size: CHUNK })).done) return; }
    catch { single = CHUNK; }
  }
} });
