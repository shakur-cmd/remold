declare const process: { env: Record<string, string | undefined> };
import { v } from "convex/values";
import { internalAction, internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { currentPrincipal, requireMember, requireWriter, type Actor, type Principal } from "./identity";
import { fail, type ErrorCode } from "./errors";
import { applyChange } from "./lib/applyChange";
import { projections } from "./lib/slots";
import { allDay, fromInstant, readableMap, resolveValues } from "./lib/values";
import { canReadField, canReadRecord, requireRecordRead, visibleTitle } from "./authority/reads";
import { DAY, TAG, definitionOf, enqueue, fieldOf, itemByKey, nextQueued, parseSchedule, sentence, type Chain, type Definition, type Item } from "./lib/automation";

// The automation runner. A trigger (lib/automation.ts) or the minute cron queues a run
// and schedules `run`, which executes the actions in one mutation as the person who
// turned the automation on, so a failing action leaves nothing half done. Caps,
// authority and the automation's status are checked again inside that mutation.
type Ctx = QueryCtx | MutationCtx;
type Trigger = { record: Doc<"records">; item: Item } | null;
const PER_AUTOMATION = 200;
// Missing or invalid means 0: nothing runs until the deployment sets a cap.
export const dailyCap = () => { const n = Number(process.env.REMOLD_AUTOMATION_DAILY_CAP?.trim() || 0); return Number.isSafeInteger(n) && n > 0 ? n : 0; };
const messageOf = (error: unknown) => String((error as any)?.data?.message ?? (error as any)?.message ?? error);
const dateText = (ms: number) => (allDay(ms) ? new Date(ms).toISOString().slice(0, 10) : `${new Date(Math.floor(ms)).toISOString().slice(0, 16).replace("T", " ")} UTC`);

async function refOf(ctx: Ctx, principal: Principal, id: string) {
  const recordId = ctx.db.normalizeId("records", id), record = recordId && await ctx.db.get(recordId), object = record && await ctx.db.get(record.objectId);
  return record && object && record.orgId === principal.org._id && canReadRecord(principal, object, record) ? { id, ref: record.ref ?? null, object: object.key, title: await visibleTitle(ctx, principal, record) } : { id };
}

type Env = { principal: Principal; trigger: Trigger; created: Map<string, string>; today: number };
type Got = { value: unknown; field?: Doc<"fields">; date?: boolean };
// {{today+3}}, {{created.project}}, {{record.id}}, {{record.name}} and {{record.closeDate-1}}.
function tagValue(env: Env, inner: string): Got {
  const sign = (s?: string) => (s === "-" ? -1 : 1);
  let m = /^today(?:([+-])(\d+))?$/.exec(inner);
  if (m) return { value: env.today + sign(m[1]) * Number(m[2] ?? 0) * DAY, date: true };
  m = /^created\.(\w+)$/.exec(inner);
  if (m) return { value: env.created.get(m[1]!) };
  m = /^record\.(\w+)(?:([+-])(\d+))?$/.exec(inner);
  if (!m || !env.trigger) return { value: undefined };
  const { record, item } = env.trigger;
  if (m[1] === "id") return { value: record._id };
  const field = fieldOf(item, m[1]), value = field && canReadField(env.principal, item.object, field, record._id) ? record.values[field._id] : undefined;
  if (m[2] && typeof value === "number") return { value: Math.floor(value / DAY) * DAY + sign(m[2]) * Number(m[3]) * DAY, date: true };
  return { value, field };
}
async function asText(ctx: Ctx, env: Env, { value, field, date }: Got): Promise<string> {
  if (value === undefined || value === null) return "";
  if (typeof value === "number" && (date || field?.type === "date")) return dateText(value);
  if (field?.type === "select") return field.options?.find((o) => o.id === value)?.label ?? String(value);
  if (field?.type === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) return (await Promise.all(value.map((id) => asText(ctx, env, { value: id })))).join(", ");
  if (typeof value === "string" && (!field || field.type === "lookup") && ctx.db.normalizeId("records", value)) { const ref = await refOf(ctx, env.principal, value); return ("title" in ref && ref.title) || ""; }
  return String(value);
}
// A value that is one tag keeps its type (an id, a date, a number); text with tags in it becomes text.
async function render(ctx: Ctx, env: Env, input: unknown, target?: Doc<"fields">): Promise<unknown> {
  if (Array.isArray(input)) return Promise.all(input.map((item) => render(ctx, env, item)));
  if (typeof input !== "string") return input;
  const one = /^\{\{\s*([^{}]+?)\s*\}\}$/.exec(input);
  if (one && target?.type !== "text") return tagValue(env, one[1]!).value ?? null;
  let out = "", at = 0;
  for (const match of input.matchAll(TAG)) { out += input.slice(at, match.index) + await asText(ctx, env, tagValue(env, match[1]!)); at = match.index! + match[0].length; }
  return out + input.slice(at);
}

type Writer = { actor: Actor; reason: string; automation: Chain; inbox: (text: string) => Promise<unknown> };
// Runs the actions in order. Without a writer it is the dry run: the same rendering and
// value checks, nothing written, new records stood in for by "(the new Project)".
export async function perform(ctx: Ctx, principal: Principal, d: Definition, trigger: Trigger, write?: Writer) {
  const orgId = principal.org._id, env: Env = { principal, trigger, created: new Map(), today: Math.floor(Date.now() / DAY) * DAY };
  const steps: Record<string, unknown>[] = [], problems: string[] = [], created: Id<"records">[] = [], standIns = new Set<string>();
  let last: { item: Item; id: string } | null = null;
  for (const [index, action] of d.actions.entries()) {
    try {
      if (action.type === "inbox") {
        const text = String(await render(ctx, env, action.text, { type: "text" } as Doc<"fields">)).trim();
        steps.push({ action: "inbox", text });
        if (write) await write.inbox(text);
        continue;
      }
      let item: Item | null = null, recordId: string | undefined, input: Record<string, unknown> = {};
      if (action.type === "createRecord") { item = await itemByKey(ctx, orgId, action.object); input = action.values ?? {}; }
      else if (action.type === "createTask") { item = await itemByKey(ctx, orgId, "task"); input = { ...action.values, title: action.title, ...(action.dueInDays !== undefined ? { dueDate: env.today + action.dueInDays * DAY } : {}), ...(action.about === "trigger" ? { about: trigger?.record._id } : action.about === "created" ? { about: last?.id } : {}) }; }
      else if (action.type === "updateTrigger") { item = trigger?.item ?? null; recordId = trigger?.record._id; input = action.values ?? {}; }
      else if (action.type === "linkTrigger") {
        item = last?.item ?? null; recordId = last?.id;
        const field = fieldOf(item, action.field), current = field && !standIns.has(recordId ?? "") ? (await ctx.db.get(recordId as Id<"records">))?.values[field._id] : undefined;
        input = { [action.field ?? ""]: field?.type === "links" ? [...((current as string[] | undefined) ?? []), trigger?.record._id] : trigger?.record._id };
      } else fail("VALIDATION", `Unknown action "${action.type}"`);
      const creates = action.type === "createRecord" || action.type === "createTask";
      if (!item || (!creates && !recordId)) fail("NOT_FOUND", "Its record or object no longer exists");
      const rendered: Record<string, unknown> = {}, pending: Record<string, unknown> = {};
      for (const [key, raw] of Object.entries(input)) {
        if (raw === undefined) continue;
        const value = await render(ctx, env, raw, fieldOf(item, key));
        if (typeof value === "string" && standIns.has(value)) pending[key] = value; else rendered[key] = value;
      }
      const values = await resolveValues(ctx, principal, item!.object, item!.fields, rendered);
      if (write) {
        const change = creates ? { action: "create" as const, orgId, objectId: item!.object._id, values, reason: write.reason } : { action: "update" as const, orgId, recordId: recordId as Id<"records">, values, reason: write.reason };
        const result = await applyChange(ctx as MutationCtx, principal, change, { actor: write.actor, automation: write.automation });
        if (creates) { created.push(result.recordId); env.created.set(item!.object.key, result.recordId); last = { item: item!, id: result.recordId }; }
        continue;
      }
      const shown = { ...(await readableMap(ctx, principal, item!.fields, values)), ...pending };
      if (!creates) { steps.push({ action: "update", object: item!.object.key, record: standIns.has(recordId!) ? recordId : await refOf(ctx, principal, recordId!), values: shown }); continue; }
      const standIn = `(the new ${item!.object.label})`;
      standIns.add(standIn); env.created.set(item!.object.key, standIn); last = { item: item!, id: standIn };
      steps.push({ action: "create", object: item!.object.key, values: shown });
    } catch (error) {
      const message = `Action ${index + 1}: ${messageOf(error)}`;
      if (write) fail(((error as any)?.data?.code as ErrorCode) ?? "VALIDATION", message);
      problems.push(message);
    }
  }
  return { steps, problems, created };
}

async function stateOf(ctx: Ctx, automationId: Id<"records">) {
  return ctx.db.query("automationState").withIndex("by_automation", (q) => q.eq("automationId", automationId)).unique();
}
// Engine bookkeeping on the automation record (last run, pausing) is written directly:
// it must work in a read-only workspace and must not count as editing the automation.
async function patchValues(ctx: MutationCtx, recordId: Id<"records">, changes: Record<string, unknown>) {
  const record = await ctx.db.get(recordId);
  if (!record) return null;
  const fields = await ctx.db.query("fields").withIndex("by_object", (q) => q.eq("orgId", record.orgId).eq("objectId", record.objectId)).collect();
  const values = { ...record.values, ...changes };
  await ctx.db.patch(recordId, { values, ...projections(fields, values) });
  return record;
}
async function pause(ctx: MutationCtx, automation: Doc<"records">, item: Item, state: Doc<"automationState">, text: string) {
  const status = fieldOf(item, "status"), record = await ctx.db.get(automation._id);
  if (status && record?.values[status._id] === "on") {
    await patchValues(ctx, automation._id, { [status._id]: "paused" });
    await ctx.db.insert("events", { orgId: automation.orgId, actor: { kind: "automation", id: automation._id }, action: "update", objectId: item.object._id, recordId: automation._id, before: { [status._id]: "on" }, after: { [status._id]: "paused" }, reason: text });
  }
  await ctx.db.patch(state._id, { on: false });
  await ctx.db.insert("agentInbox", { orgId: automation.orgId, text, source: "automation", from: { kind: "user", id: state.enabledBy }, status: "pending", audience: "author", recordId: automation._id });
}
// Counts one run against today's workspace cap and the automation's own cap, or says why not.
async function reserve(ctx: MutationCtx, orgId: Id<"orgs">, automationId: Id<"records">, force: boolean) {
  const day = Math.floor(Date.now() / DAY), keys = [[`${day}:${orgId}`, dailyCap()], [`${day}:${automationId}`, PER_AUTOMATION]] as const, rows = [];
  for (const [key, cap] of keys) {
    const row = await ctx.db.query("automationCaps").withIndex("by_key", (q) => q.eq("key", key)).unique();
    if (!force && (row?.used ?? 0) >= cap) return cap === 0 ? "Automations are off on this server: the daily limit (REMOLD_AUTOMATION_DAILY_CAP) is 0" : `Daily limit of ${cap} runs reached`;
    rows.push({ key, row });
  }
  for (const { key, row } of rows) if (row) await ctx.db.patch(row._id, { used: row.used + 1 }); else await ctx.db.insert("automationCaps", { key, used: 1 });
  return null;
}

// Runs one queued run and returns the automation's next queued run, if any.
export const execute = internalMutation({ args: { runId: v.id("automationRuns") }, handler: async (ctx, { runId }) => {
  const run = await ctx.db.get(runId);
  if (!run) return null;
  if (run.status === "queued") await step(ctx, run);
  return nextQueued(ctx, run.automationId);
} });
async function step(ctx: MutationCtx, run: Doc<"automationRuns">) {
  const runId = run._id;
  const finish = (status: "done" | "refused" | "skipped", error?: string, created: Id<"records">[] = []) => ctx.db.patch(runId, { status, created, finishedAt: Date.now(), ...(error ? { error } : {}) });
  const automation = await ctx.db.get(run.automationId), item = await itemByKey(ctx, run.orgId, "automation"), state = await stateOf(ctx, run.automationId);
  if (!automation || !item || !state?.on) return finish("skipped", "The automation was not on");
  const d = definitionOf(item, automation.values), org = await ctx.db.get(run.orgId), user = await ctx.db.get(state.enabledBy), member = await ctx.db.get(state.memberId);
  // The person who turned it on, as they were then: a changed role, removal or read-only workspace refuses and pauses.
  let principal: Principal | null = null;
  if (org && !org.flags?.readonly && user && member) principal = await currentPrincipal(ctx, { user, member: { ...member, authorityEpoch: state.epoch }, org, actor: { kind: "user", id: user._id } }).catch(() => null);
  if (!principal) {
    const reason = !org || org.flags?.readonly ? "the workspace is read only" : `${user?.name ?? "the person who turned it on"} no longer has the access they had when turning it on`;
    await finish("refused", reason[0]!.toUpperCase() + reason.slice(1));
    return pause(ctx, automation, item, state, `Automation "${d.name}" paused: ${reason}. Turn it on again to run it as you.`);
  }
  let trigger: Trigger = null;
  if (run.triggerRecordId) {
    const record = await ctx.db.get(run.triggerRecordId), object = record && await ctx.db.get(record.objectId), triggerItem = object && await itemByKey(ctx, run.orgId, object.key);
    if (!record || !triggerItem) return finish("skipped", "Its record was deleted");
    if (!canReadRecord(principal, triggerItem.object, record)) return finish("refused", `${user!.name} cannot see this record`);
    trigger = { record, item: triggerItem };
  }
  const limit = await reserve(ctx, run.orgId, run.automationId, false);
  if (limit) return finish("skipped", limit);
  const inbox = (text: string) => ctx.db.insert("agentInbox", { orgId: run.orgId, text, source: "automation", from: { kind: "user", id: state.enabledBy }, status: "pending", audience: "author", recordId: trigger?.record._id ?? automation._id });
  const { created } = await perform(ctx, principal, d, trigger, { actor: { kind: "automation", id: automation._id }, reason: `Automation "${d.name}", turned on by ${user!.name}`, automation: { depth: run.depth, chain: run.chain }, inbox });
  await finish("done", undefined, created);
  await ctx.db.patch(state._id, { failures: 0 });
  const lastRun = fieldOf(item, "lastRun");
  if (lastRun) await patchValues(ctx, automation._id, { [lastRun._id]: fromInstant(Date.now()) });
}

// A run whose actions threw: execute's writes were undone; record it, and pause after 3 in a row.
export const failed = internalMutation({ args: { runId: v.id("automationRuns"), error: v.string() }, handler: async (ctx, { runId, error }) => {
  const run = await ctx.db.get(runId);
  if (!run) return null;
  if (run.status === "queued") await recordFailure(ctx, run, error);
  return nextQueued(ctx, run.automationId);
} });
async function recordFailure(ctx: MutationCtx, run: Doc<"automationRuns">, error: string) {
  const runId = run._id;
  await reserve(ctx, run.orgId, run.automationId, true);
  await ctx.db.patch(runId, { status: "failed", error, finishedAt: Date.now() });
  const state = await stateOf(ctx, run.automationId), automation = await ctx.db.get(run.automationId), item = await itemByKey(ctx, run.orgId, "automation");
  if (!state?.on || !automation || !item) return;
  await ctx.db.patch(state._id, { failures: state.failures + 1 });
  if (state.failures + 1 >= 3) await pause(ctx, automation, item, state, `Automation "${definitionOf(item, automation.values).name}" paused after 3 failed runs in a row. Last error: ${error}`);
}

// Works through an automation's queue from `runId`; a long queue continues in a fresh job.
export const run = internalAction({ args: { runId: v.id("automationRuns") }, handler: async (ctx, { runId }) => {
  let next: Id<"automationRuns"> | null = runId;
  for (let i = 0; next && i < 100; i++) {
    const id: Id<"automationRuns"> = next;
    try { next = await ctx.runMutation(internal.automations.execute, { runId: id }); }
    catch (error) { next = await ctx.runMutation(internal.automations.failed, { runId: id, error: messageOf(error).slice(0, 1000) }); }
  }
  if (next) await ctx.scheduler.runAfter(0, internal.automations.run, { runId: next });
} });

// Every minute: schedules that are due today and dates that land on today (UTC), once per day each.
export const tick = internalMutation({ args: {}, handler: async (ctx) => {
  const now = Date.now(), today = Math.floor(now / DAY) * DAY;
  // A queue whose runner died (a crash, a deploy) is picked up again; a run already done is never redone.
  const stuck = new Set<Id<"records">>();
  for (const run of await ctx.db.query("automationRuns").withIndex("by_status", (q) => q.eq("status", "queued").lt("_creationTime", now - 10 * 60_000)).take(100)) if (!stuck.has(run.automationId)) { stuck.add(run.automationId); await ctx.scheduler.runAfter(0, internal.automations.run, { runId: run._id }); }
  const on = (when: string) => ctx.db.query("automationState").withIndex("by_when", (q) => q.eq("on", true).eq("when", when)).take(500);
  const definition = async (state: Doc<"automationState">) => { const record = await ctx.db.get(state.automationId), item = await itemByKey(ctx, state.orgId, "automation"); return record && item ? definitionOf(item, record.values) : null; };
  for (const state of await on("schedule")) {
    const schedule = parseSchedule((await definition(state))?.schedule), at = today + (schedule?.minutes ?? 0) * 60_000;
    if (!schedule || (schedule.weekday !== undefined && new Date(today).getUTCDay() !== schedule.weekday) || now < at || at < state.enabledAt) continue;
    await enqueue(ctx, state, { key: `${state.automationId}:day:${today}`, depth: 1, chain: [state.automationId] });
  }
  for (const state of await on("dateReached")) {
    const d = await definition(state), trigger = await itemByKey(ctx, state.orgId, d?.object), field = fieldOf(trigger, d?.field);
    if (!d || !trigger || field?.type !== "date") continue;
    const day = today - (d.offsetDays ?? 0) * DAY, slot = field.slot && `${field.slot.kind}${field.slot.index}`;
    const records: Doc<"records">[] = slot
      ? await (ctx.db.query("records") as any).withIndex(`by_${slot}`, (q: any) => q.eq("orgId", state.orgId).eq("objectId", trigger.object._id).gte(slot, day).lt(slot, day + DAY)).take(200)
      : (await ctx.db.query("records").withIndex("by_object", (q) => q.eq("orgId", state.orgId).eq("objectId", trigger.object._id)).take(5000)).filter((r) => { const value = r.values[field._id]; return typeof value === "number" && value >= day && value < day + DAY; }).slice(0, 200);
    for (const record of records) await enqueue(ctx, state, { key: `${state.automationId}:${record._id}:${today}`, triggerRecordId: record._id, depth: 1, chain: [state.automationId] });
  }
} });

async function automationItem(ctx: Ctx, principal: Principal, record: Doc<"records">) {
  const object = await ctx.db.get(record.objectId), item = object?.isStandard && object.key === "automation" ? await itemByKey(ctx, record.orgId, "automation") : null;
  if (!item || record.orgId !== principal.org._id) fail("NOT_FOUND", "Automation not found");
  requireRecordRead(principal, item.object, record);
  return item;
}
const definitionOrNull = (item: Item, record: Doc<"records">) => { try { return definitionOf(item, record.values); } catch { return null; } };

// The automation in one sentence and its last 50 runs, newest first, as the caller may read them.
export async function history(ctx: Ctx, principal: Principal, record: Doc<"records">) {
  const item = await automationItem(ctx, principal, record), d = definitionOrNull(item, record), status = fieldOf(item, "status");
  const rows = await ctx.db.query("automationRuns").withIndex("by_automation", (q) => q.eq("automationId", record._id)).order("desc").take(50);
  const runs = await Promise.all(rows.map(async (run) => ({ id: run._id, status: run.status, error: run.error ?? null, at: run._creationTime, finishedAt: run.finishedAt ?? null, depth: run.depth, enabledBy: (await ctx.db.get(run.enabledBy))?.name ?? null, trigger: run.triggerRecordId ? await refOf(ctx, principal, run.triggerRecordId) : null, created: await Promise.all(run.created.map((id) => refOf(ctx, principal, id))) })));
  return { automation: { id: record._id, ref: record.ref ?? null, title: await visibleTitle(ctx, principal, record), status: (status && record.values[status._id]) ?? "draft", sentence: d ? await sentence(ctx, record.orgId, d) : "Its actions are not valid JSON" }, runs };
}

export async function dryRun(ctx: Ctx, principal: Principal, record: Doc<"records">, triggerRecord: Doc<"records"> | null) {
  const item = await automationItem(ctx, principal, record), d = definitionOf(item, record.values);
  let trigger: Trigger = null;
  if (d.when !== "schedule") {
    const watched = await itemByKey(ctx, record.orgId, d.object);
    if (!watched) fail("VALIDATION", "Choose the object it watches first");
    const which = `${/^[aeiou]/i.test(watched.object.label) ? "an" : "a"} ${watched.object.label}`;
    if (!triggerRecord || triggerRecord.objectId !== watched.object._id) fail("VALIDATION", `Test it with ${which} record`);
    requireRecordRead(principal, watched.object, triggerRecord);
    trigger = { record: triggerRecord, item: watched };
  }
  const { steps, problems } = await perform(ctx, principal, d, trigger);
  return { sentence: await sentence(ctx, record.orgId, d), steps, problems };
}

// Each action in plain words, for the automation's page.
async function lines(ctx: Ctx, orgId: Id<"orgs">, d: Definition) {
  const label = async (objectKey: string | undefined, values: Record<string, unknown> = {}) => {
    const item = await itemByKey(ctx, orgId, objectKey);
    const made = /^\{\{\s*created\.(\w+)\s*\}\}$/;
    const shown = async (value: unknown) => { const key = typeof value === "string" ? made.exec(value)?.[1] : undefined; return key ? `the new ${(await itemByKey(ctx, orgId, key))?.object.label ?? key}` : JSON.stringify(value); };
    return (await Promise.all(Object.entries(values).map(async ([key, value]) => `${fieldOf(item, key)?.label ?? key} ${await shown(value)}`))).join(", ");
  };
  const out = [];
  for (const action of d.actions) {
    const item = await itemByKey(ctx, orgId, action.type === "createTask" ? "task" : action.type === "updateTrigger" ? d.object : action.object), name = item?.object.label ?? action.object ?? "record";
    if (action.type === "createRecord") out.push(`Create ${/^[aeiou]/i.test(name) ? "an" : "a"} ${name}: ${await label(action.object, action.values)}`);
    else if (action.type === "createTask") out.push(`Create a task "${action.title}"${action.dueInDays !== undefined ? `, due in ${action.dueInDays} ${action.dueInDays === 1 ? "day" : "days"}` : ""}${action.about === "trigger" ? ", about the record" : action.about === "created" ? ", about the new record" : ""}${action.values ? `, ${await label("task", action.values)}` : ""}`);
    else if (action.type === "updateTrigger") out.push(`Update the ${name}: ${await label(d.object, action.values)}`);
    else if (action.type === "inbox") out.push(`Add to the inbox: "${action.text}"`);
    else out.push(`Link the new record back through ${action.field}`);
  }
  return out;
}

export const view = query({ args: { orgId: v.id("orgs"), recordId: v.id("records") }, handler: async (ctx, args) => {
  const principal = await requireMember(ctx, args.orgId), record = await ctx.db.get(args.recordId);
  if (!record || record.orgId !== args.orgId) return null;
  const { automation, runs } = await history(ctx, principal, record), d = definitionOrNull((await itemByKey(ctx, args.orgId, "automation"))!, record);
  return { sentence: automation.sentence, status: automation.status, actions: d ? await lines(ctx, args.orgId, d) : [], runs, dailyLimit: dailyCap() };
} });

export const setOn = mutation({ args: { orgId: v.id("orgs"), recordId: v.id("records"), on: v.boolean() }, handler: async (ctx, args) => {
  const member = await requireWriter(ctx, args.orgId), record = await ctx.db.get(args.recordId);
  if (!record || record.orgId !== args.orgId) fail("NOT_FOUND", "Automation not found");
  const status = fieldOf(await automationItem(ctx, member, record), "status");
  if (!status) fail("VALIDATION", "This automation has no status field");
  await applyChange(ctx, member, { action: "update", orgId: args.orgId, recordId: record._id, values: { [status._id]: args.on ? "on" : "paused" }, reason: args.on ? "Turned on" : "Paused" });
} });
