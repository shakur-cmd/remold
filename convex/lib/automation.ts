import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Principal } from "../identity";
import { fail } from "../errors";
import { canReadField, canReadRecordId } from "../authority/reads";
import { projections } from "./slots";

// The rules an Automation record follows on every write, and the event triggers. The
// runner itself (actions, caps, the cron) is convex/automations.ts.
type Ctx = QueryCtx | MutationCtx;
export type Item = { object: Doc<"objects">; fields: Doc<"fields">[] };
export type Action = { type: string; object?: string; values?: Record<string, unknown>; title?: string; dueInDays?: number; about?: string; text?: string; field?: string };
export type Definition = { name: string; when?: string; object?: string; field?: string; equals?: string; offsetDays?: number; schedule?: string; actions: Action[]; status?: string };
export type Chain = { depth: number; chain: Id<"records">[] };
export const DAY = 86_400_000, MAX_DEPTH = 3;
const KINDS = ["createRecord", "updateTrigger", "createTask", "inbox", "linkTrigger"];
// Statuses that send, publish, start or book something stay behind their own approval gates.
const GATED = ["email", "post", "campaign", "booking"];
const DEFINITION = ["when", "object", "field", "equals", "offsetDays", "schedule", "actions"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"], DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const empty = (value: unknown) => value === null || value === undefined || value === "";
export const TAG = /\{\{\s*([^{}]+?)\s*\}\}/g;

export async function itemByKey(ctx: Ctx, orgId: Id<"orgs">, key: string | undefined): Promise<Item | null> {
  if (!key) return null;
  const object = await ctx.db.query("objects").withIndex("by_org_key", (q) => q.eq("orgId", orgId).eq("key", key)).unique();
  if (!object) return null;
  const fields = await ctx.db.query("fields").withIndex("by_object", (q) => q.eq("orgId", orgId).eq("objectId", object._id)).collect();
  return { object, fields: fields.filter((field) => !field.retired) };
}
export const fieldOf = (item: Item | null, key: string | undefined) => (key ? item?.fields.find((field) => field.key === key) : undefined);

// "daily 09:00" or "weekly mon 09:00", in UTC.
export function parseSchedule(text: string | undefined) {
  const match = /^(?:daily|weekly (sun|mon|tue|wed|thu|fri|sat)) ([01]\d|2[0-3]):([0-5]\d)$/i.exec(text?.trim() ?? "");
  return match ? { weekday: match[1] ? DAYS.indexOf(match[1].toLowerCase()) : undefined, minutes: +match[2]! * 60 + +match[3]! } : null;
}

// The next time a schedule is due at or after `from` (UTC).
export function nextDue(text: string | undefined, from: number) {
  const schedule = parseSchedule(text);
  if (!schedule) return undefined;
  const day = Math.floor(from / DAY) * DAY;
  for (let i = 0; i <= 7; i++) { const at = day + i * DAY + schedule.minutes * 60_000; if (at >= from && (schedule.weekday === undefined || new Date(day + i * DAY).getUTCDay() === schedule.weekday)) return at; }
  return undefined;
}

// What the person an automation runs as must be able to read for its trigger to tell
// them nothing new: every record of the watched object, and the field it watches or
// matches on. Null when they can; otherwise what they are missing, in words.
export function triggerAccess(principal: Principal, trigger: Item | null, d: Definition) {
  if (d.when === "schedule" || !trigger) return null;
  const field = d.when === "recordCreated" && !d.equals ? undefined : fieldOf(trigger, d.field);
  if (!canReadRecordId(principal, trigger.object) || (field && !canReadField(principal, trigger.object, field))) return `every ${trigger.object.labelPlural.toLowerCase()}${field ? ` and their ${field.label.toLowerCase()}` : ""}`;
  return null;
}

export function definitionOf(automation: Item, values: Record<string, unknown>): Definition {
  const raw = (key: string) => { const field = fieldOf(automation, key); return field ? values[field._id] : undefined; };
  const text = (key: string) => { const value = raw(key); return typeof value === "string" && value.trim() ? value.trim() : undefined; };
  let actions: unknown = [];
  if (text("actions")) {
    try { actions = JSON.parse(text("actions")!); } catch { actions = null; }
    if (!Array.isArray(actions)) fail("VALIDATION", 'Actions must be a JSON array, like [{"type":"inbox","text":"Call {{record.name}}"}]');
  }
  return { name: String(raw("name") ?? ""), when: text("when"), object: text("object"), field: text("field"), equals: text("equals"), offsetDays: typeof raw("offsetDays") === "number" ? raw("offsetDays") as number : undefined, schedule: text("schedule"), actions: actions as Action[], status: text("status") };
}

// Whether a stored value matches `equals`: a select by option id or label, anything else as text.
export function matches(field: Doc<"fields">, value: unknown, equals: string | undefined) {
  if (empty(equals)) return true;
  if (empty(value)) return false;
  const want = equals!.trim().toLowerCase(), option = field.type === "select" ? field.options?.find((o) => o.id === value) : undefined;
  if (Array.isArray(value)) return value.some((v) => String(v).toLowerCase() === want);
  return String(value).trim().toLowerCase() === want || option?.label.toLowerCase() === want;
}

// Refuses anything an automation may not do, with the reason. `complete` (turning on)
// also needs a trigger and at least one action.
export async function check(ctx: Ctx, orgId: Id<"orgs">, d: Definition, complete: boolean) {
  const bad = (message: string): never => fail("VALIDATION", message);
  if (d.actions.length > 10) bad("An automation can have at most 10 actions");
  const trigger = await itemByKey(ctx, orgId, d.object);
  if (d.object && !trigger) bad(`No object "${d.object}"`);
  if (trigger?.object.key === "automation") bad("Automations cannot start from other automations");
  const field = fieldOf(trigger, d.field);
  if (trigger && d.field && !field) bad(`No field "${d.field}" on ${trigger.object.label}`);
  if (d.when === "dateReached" && field && field.type !== "date") bad(`${field.label} is not a date`);
  if (d.when === "dateReached" && field?.type === "date" && !field.slot) bad(`${field.label} is not indexed, so it cannot start an automation`);
  if (field?.type === "select" && d.equals && !field.options?.some((o) => matches(field, o.id, d.equals))) bad(`${field.label} has no option "${d.equals}"`);
  if (d.schedule && !parseSchedule(d.schedule)) bad('Schedule must look like "daily HH:MM" or "weekly mon HH:MM" (UTC)');
  if (d.offsetDays !== undefined && !Number.isSafeInteger(d.offsetDays)) bad("Offset days must be a whole number");
  const hasRecord = d.when !== "schedule";
  const created = new Map<string, Item>();
  const tags = (value: unknown, at: string) => {
    for (const text of (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === "string")) for (const [whole, inner] of text.matchAll(TAG)) {
      const record = /^record\.(\w+)(?:[+-]\d+)?$/.exec(inner!), made = /^created\.(\w+)$/.exec(inner!);
      if (/^today(?:[+-]\d+)?$/.test(inner!)) continue;
      if (record && hasRecord && (record[1] === "id" || fieldOf(trigger, record[1]))) continue;
      if (made && created.has(made[1]!)) continue;
      bad(`${at}unknown field "${record?.[1] ?? made?.[1] ?? inner}" in ${whole}. Use {{record.field}}, {{record.id}}, {{today+3}} or {{created.object}}`);
    }
  };
  const writes = (item: Item, values: unknown, at: string) => {
    if (values === undefined) return;
    if (!values || typeof values !== "object" || Array.isArray(values)) bad(`${at}values must be an object of field keys`);
    if (item.object.key === "automation") bad(`${at}automations cannot create or change automations`);
    for (const [key, value] of Object.entries(values as object)) {
      if (!fieldOf(item, key)) bad(`${at}unknown field "${key}" on ${item.object.label}`);
      if (GATED.includes(item.object.key) && key === "status") bad(`${at}automations cannot set an email, post, campaign or booking status; a person does that`);
      tags(value, at);
    }
  };
  let last: Item | null = null;
  for (const [index, action] of d.actions.entries()) {
    const at = `Action ${index + 1}: `;
    if (!action || typeof action !== "object" || typeof action.type !== "string") bad(`${at}each action needs a type`);
    if (!KINDS.includes(action.type)) {
      if (/delete|remove|archive|destroy/i.test(action.type)) bad(`${at}automations cannot delete anything`);
      if (/send|mail|post|publish|book|webhook|http|sms|message|call|notify/i.test(action.type)) bad(`${at}automations cannot send, publish or book anything; a person does that`);
      bad(`${at}unknown action "${action.type}". Use createRecord, updateTrigger, createTask, inbox or linkTrigger`);
    }
    const needsRecord = () => { if (!hasRecord) bad(`${at}a scheduled automation has no record to ${action.type === "linkTrigger" ? "link" : "update"}`); if (!trigger) bad(`${at}choose the object it watches first`); return trigger!; };
    if (action.type === "createRecord") {
      const item = await itemByKey(ctx, orgId, action.object);
      if (!item) bad(`${at}no object "${action.object ?? ""}"`);
      writes(item!, action.values ?? {}, at);
      created.set(item!.object.key, item!); last = item;
    } else if (action.type === "updateTrigger") writes(needsRecord(), action.values ?? {}, at);
    else if (action.type === "createTask") {
      const task = await itemByKey(ctx, orgId, "task");
      if (!task) bad(`${at}this workspace has no Task object`);
      if (typeof action.title !== "string" || !action.title.trim()) bad(`${at}a task needs a title`);
      if (action.dueInDays !== undefined && !Number.isSafeInteger(action.dueInDays)) bad(`${at}dueInDays must be a whole number`);
      if (action.about !== undefined && action.about !== "trigger" && action.about !== "created") bad(`${at}about must be "trigger" or "created"`);
      if (action.about === "trigger") needsRecord();
      if (action.about === "created" && !last) bad(`${at}nothing was created before this task`);
      tags(action.title, at); writes(task!, action.values, at);
      created.set("task", task!); last = task;
    } else if (action.type === "inbox") {
      if (typeof action.text !== "string" || !action.text.trim()) bad(`${at}an inbox item needs text`);
      tags(action.text, at);
    } else {
      const target = needsRecord(), field = fieldOf(last, action.field);
      if (!last) bad(`${at}link back needs a record created before it`);
      if (!field || (field.type !== "lookup" && field.type !== "links") || (field.targetObjectId && field.targetObjectId !== target.object._id)) bad(`${at}${last!.object.label} has no field "${action.field ?? ""}" that can point to ${target.object.label}`);
    }
  }
  if (!complete) return;
  if (!d.when) bad("Choose when it runs");
  if (hasRecord && !trigger) bad("Choose the object it watches");
  if ((d.when === "fieldChanged" || d.when === "dateReached") && !field) bad("Choose the field it watches");
  if (d.when === "schedule" && !d.schedule) bad('Add a schedule, like "daily 09:00" or "weekly mon 09:00" (UTC)');
  if (!d.actions.length) bad("Add at least one action");
}

const article = (label: string) => `${/^[aeiou]/i.test(label) ? "an" : "a"} ${label}`;
const list = (items: string[]) => items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
const time = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

// One plain sentence: "When an Opportunity's Stage becomes Won, create a Project and 3 Tasks".
export async function sentence(ctx: Ctx, orgId: Id<"orgs">, d: Definition) {
  const trigger = await itemByKey(ctx, orgId, d.object), field = fieldOf(trigger, d.field), what = trigger ? article(trigger.object.label) : "a record";
  const equals = field?.options?.find((o) => matches(field, o.id, d.equals))?.label ?? d.equals, fieldName = field?.label ?? d.field ?? "field";
  const schedule = parseSchedule(d.schedule), offset = d.offsetDays ?? 0;
  const when = d.when === "recordCreated" ? `When ${what} is created${field && equals ? ` with ${fieldName} ${equals}` : ""}`
    : d.when === "fieldChanged" ? `When ${what}'s ${fieldName} ${equals ? `becomes ${equals}` : "changes"}`
    : d.when === "dateReached" ? (offset ? `${Math.abs(offset)} ${Math.abs(offset) === 1 ? "day" : "days"} ${offset < 0 ? "before" : "after"} ${what}'s ${fieldName}` : `On ${what}'s ${fieldName}`)
    : d.when === "schedule" ? (schedule ? `Every ${schedule.weekday === undefined ? "day" : DAY_NAMES[schedule.weekday]} at ${time(schedule.minutes)} UTC` : "On a schedule not set yet")
    : "When nothing yet";
  const groups: { verb: string; noun: string; key: string; count: number }[] = [];
  for (const action of d.actions) {
    const objectKey = action.type === "createTask" ? "task" : action.object ?? "", key = `${action.type === "createTask" ? "createRecord" : action.type}:${objectKey}`, prev = groups.at(-1);
    if (prev?.key === key) { prev.count++; continue; }
    groups.push({ verb: { createRecord: "create", createTask: "create", updateTrigger: "update", inbox: "add", linkTrigger: "link" }[action.type] ?? "do", noun: objectKey, key, count: 1 });
  }
  const phrases = [];
  for (const [index, group] of groups.entries()) {
    const item = group.verb === "create" ? await itemByKey(ctx, orgId, group.noun) : null, many = group.count > 1;
    const noun = group.verb === "create" ? (many ? `${group.count} ${item?.object.labelPlural ?? group.noun}` : article(item?.object.label ?? group.noun))
      : group.verb === "update" ? `the ${trigger?.object.label ?? "record"}` : group.verb === "add" ? (many ? `${group.count} inbox items` : "an inbox item") : group.verb === "link" ? "it back" : "something";
    phrases.push(groups[index - 1]?.verb === group.verb ? noun : `${group.verb} ${noun}`);
  }
  return `${when}, ${phrases.length ? list(phrases) : "do nothing yet"}`;
}

// Before an Automation record is written (inside applyChange): it starts as a draft;
// only a person turns one on; changing what an on automation does pauses it; and what
// it would do is checked, fully when it is being turned on.
export async function automationRules(ctx: MutationCtx, principal: Principal, automation: Item, before: Record<string, unknown> | null, values: Record<string, unknown>, validated: Record<string, unknown>) {
  const status = fieldOf(automation, "status");
  if (!status) return;
  if (empty(values[status._id])) values[status._id] = validated[status._id] = "draft";
  const was = before?.[status._id], edited = !before || DEFINITION.some((key) => { const field = fieldOf(automation, key); return !!field && !same(before[field._id], values[field._id]); });
  if (was === "on" && values[status._id] === "on" && edited) values[status._id] = validated[status._id] = "paused";
  const turningOn = values[status._id] === "on" && was !== "on";
  if (turningOn && !("member" in principal)) fail("FORBIDDEN", "Only a person can turn on an automation", { fieldId: status._id });
  if (edited || turningOn) await check(ctx, automation.object.orgId, definitionOf(automation, values), values[status._id] === "on");
  if (turningOn) {
    const d = definitionOf(automation, values), missing = triggerAccess(principal, await itemByKey(ctx, automation.object.orgId, d.object), d);
    if (missing) fail("FORBIDDEN", `To turn this on you need to see ${missing}, because it runs as you`, { fieldId: status._id });
  }
}

// After an Automation record is written: the state row follows its status and names
// who turned it on. After any other write: start the automations it triggers.
export async function automationAfter(ctx: MutationCtx, principal: Principal, object: Doc<"objects">, fields: Doc<"fields">[], action: "create" | "update" | "delete", before: Record<string, unknown> | null, after: Record<string, unknown> | null, recordId: Id<"records">, eventId: Id<"events">, from?: Chain) {
  if (object.isStandard && object.key === "automation") {
    const state = await ctx.db.query("automationState").withIndex("by_automation", (q) => q.eq("automationId", recordId)).unique();
    if (!after) { if (state) await ctx.db.delete(state._id); return; }
    const status = fields.find((f) => f.key === "status" && !f.retired), now = status && after[status._id], was = status && before?.[status._id];
    if (now === "on" && was !== "on" && "member" in principal) {
      const d = definitionOf({ object, fields: fields.filter((f) => !f.retired) }, after);
      const now = Date.now(), dueAt = d.when === "schedule" ? nextDue(d.schedule, now) : undefined;
      const row = { orgId: object.orgId, automationId: recordId, on: true, objectKey: d.when === "schedule" ? "" : d.object ?? "", when: d.when ?? "", enabledBy: principal.user._id, memberId: principal.member._id, epoch: principal.member.authorityEpoch ?? 0, enabledAt: now, failures: 0, ...(dueAt !== undefined ? { dueAt } : {}), ...(d.when === "dateReached" ? { scannedAt: 0 } : {}) };
      if (state) await ctx.db.replace(state._id, row); else await ctx.db.insert("automationState", row);
    } else if (now !== "on" && state?.on) await ctx.db.patch(state._id, { on: false });
    return;
  }
  if (action === "delete" || !after) return;
  const states = await ctx.db.query("automationState").withIndex("by_org_object", (q) => q.eq("orgId", object.orgId).eq("on", true).eq("objectKey", object.key)).collect();
  if (!states.length) return;
  const automation = await itemByKey(ctx, object.orgId, "automation");
  for (const state of states) {
    // A run's writes never set off an automation already in its chain, itself included.
    if (!automation || from?.chain.includes(state.automationId)) continue;
    const record = await ctx.db.get(state.automationId);
    if (!record) continue;
    const d = definitionOf(automation, record.values), field = fields.find((f) => f.key === d.field && !f.retired);
    const fires = d.when === "recordCreated" ? action === "create" && (!field || matches(field, after[field._id], d.equals))
      : d.when === "fieldChanged" ? !!field && !same(before?.[field._id], after[field._id]) && matches(field, after[field._id], d.equals) : false;
    if (fires) await enqueue(ctx, state, { key: `${state.automationId}:${eventId}`, triggerRecordId: recordId, eventId, depth: (from?.depth ?? 0) + 1, chain: [...(from?.chain ?? []), state.automationId] });
  }
}

export const nextQueued = async (ctx: Ctx, automationId: Id<"records">) => (await ctx.db.query("automationRuns").withIndex("by_automation_status", (q) => q.eq("automationId", automationId).eq("status", "queued")).first())?._id ?? null;
// Engine bookkeeping on the automation record (last run, pausing) is written directly:
// it must work in a read-only workspace and must not count as editing the automation.
export async function patchValues(ctx: MutationCtx, recordId: Id<"records">, changes: Record<string, unknown>) {
  const record = await ctx.db.get(recordId);
  if (!record) return null;
  const fields = await ctx.db.query("fields").withIndex("by_object", (q) => q.eq("orgId", record.orgId).eq("objectId", record.objectId)).collect();
  const values = { ...record.values, ...changes };
  await ctx.db.patch(recordId, { values, ...projections(fields, values) });
  return record;
}
export async function pause(ctx: MutationCtx, automation: Doc<"records">, item: Item, state: Doc<"automationState">, text: string) {
  const status = fieldOf(item, "status"), record = await ctx.db.get(automation._id);
  if (status && record?.values[status._id] === "on") {
    await patchValues(ctx, automation._id, { [status._id]: "paused" });
    await ctx.db.insert("events", { orgId: automation.orgId, actor: { kind: "automation", id: automation._id }, action: "update", objectId: item.object._id, recordId: automation._id, before: { [status._id]: "on" }, after: { [status._id]: "paused" }, reason: text });
  }
  await ctx.db.patch(state._id, { on: false });
  await ctx.db.insert("agentInbox", { orgId: automation.orgId, text, source: "automation", from: { kind: "user", id: state.enabledBy }, status: "pending", audience: "author", recordId: automation._id });
}
// One run per dedupe key. Past the depth cap the run is kept, as skipped, so the history says why.
// An automation's runs go one at a time, oldest first: the runner started for the first
// waiting run works through the rest, so a busy write schedules one job, not one per run.
export async function enqueue(ctx: MutationCtx, state: Doc<"automationState">, run: { key: string; triggerRecordId?: Id<"records">; eventId?: Id<"events">; depth: number; chain: Id<"records">[] }) {
  if (await ctx.db.query("automationRuns").withIndex("by_key", (q) => q.eq("key", run.key)).first()) return;
  // The person it runs as changed (role, scope, removal) since turning it on: no run is
  // queued, so nothing records which record matched; it pauses until someone turns it on again.
  const member = await ctx.db.get(state.memberId);
  if (!member || (member.authorityEpoch ?? 0) !== state.epoch) {
    const automation = await ctx.db.get(state.automationId), item = await itemByKey(ctx, state.orgId, "automation"), user = await ctx.db.get(state.enabledBy);
    if (automation && item) return pause(ctx, automation, item, state, `Automation "${definitionOf(item, automation.values).name}" paused: ${user?.name ?? "the person who turned it on"} no longer has the access they had when turning it on. Turn it on again to run it as you.`);
    return;
  }
  const over = run.depth > MAX_DEPTH, waiting = await nextQueued(ctx, state.automationId);
  const runId = await ctx.db.insert("automationRuns", { orgId: state.orgId, automationId: state.automationId, ...run, enabledBy: state.enabledBy, created: [], status: over ? "skipped" : "queued", ...(over ? { error: `Stopped: automations can set each other off at most ${MAX_DEPTH} deep`, finishedAt: Date.now() } : {}) });
  if (!over && !waiting) await ctx.scheduler.runAfter(0, internal.automations.run, { runId });
}

