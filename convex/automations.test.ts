import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import { agentFor, api, bulk, objectFields, rest, userAndOrg } from "./test.helpers";
import { RemoldClient } from "../packages/mcp/src/client";
import crons from "./crons";

// Automations: agents draft them as records, a person turns them on, and Remold runs
// their actions as that person when a record is created, a field changes, a date
// comes round or a schedule is due.
const DAY = 86_400_000, start = Date.UTC(2026, 9, 5, 8, 30);
const KEYS = ["automation", "opportunity", "project", "task", "note", "activity", "company", "post", "email"];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(start); process.env.REMOLD_AUTOMATION_DAILY_CAP = "100"; });
afterEach(() => { vi.useRealTimers(); delete process.env.REMOLD_AUTOMATION_DAILY_CAP; });

async function world(name = "Owner") {
  const f = await userAndOrg(name);
  const o: Record<string, any> = {};
  for (const key of KEYS) o[key] = await objectFields(f.client, f.orgId, key);
  const ids = (key: string, values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).map(([k, v]) => [o[key].fields[k]._id, v]));
  const as = (client: any) => ({
    create: async (key: string, values: Record<string, unknown>) => (await client.mutation(api.records.create, { orgId: f.orgId, objectId: o[key].object._id, values: ids(key, values) })).recordId,
    update: (key: string, recordId: any, values: Record<string, unknown>) => client.mutation(api.records.update, { orgId: f.orgId, recordId, values: ids(key, values) }),
  });
  const { create, update } = as(f.client);
  const automation = (values: Record<string, unknown>) => create("automation", { name: "Test automation", ...values, ...(values.actions ? { actions: JSON.stringify(values.actions) } : {}) });
  const turnOn = (recordId: any, client = f.client) => client.mutation(api.automations.setOn, { orgId: f.orgId, recordId, on: true });
  const read = (id: any) => f.t.run((ctx: any) => ctx.db.get(id)) as Promise<any>;
  const value = async (key: string, id: any, field: string) => (await read(id))?.values[o[key].fields[field]._id];
  const runs = (automationId?: any) => f.t.run(async (ctx: any) => (await ctx.db.query("automationRuns").collect()).filter((r: any) => !automationId || r.automationId === automationId)) as Promise<any[]>;
  const all = (key: string) => f.t.run(async (ctx: any) => ctx.db.query("records").withIndex("by_object", (q: any) => q.eq("orgId", f.orgId).eq("objectId", o[key].object._id)).collect()) as Promise<any[]>;
  const drain = () => f.t.finishAllScheduledFunctions(vi.runAllTimers);
  const tick = async () => { await f.t.mutation(internal.automations.tick, {}); await drain(); };
  const inbox = () => f.t.run((ctx: any) => ctx.db.query("agentInbox").collect()) as Promise<any[]>;
  return { ...f, o, ids, as, create, update, automation, turnOn, read, value, runs, all, drain, tick, inbox };
}
type World = Awaited<ReturnType<typeof world>>;
async function join(w: World, name: string, role: "admin" | "member" = "admin") {
  const invite = await w.client.mutation(api.invites.create, { orgId: w.orgId, role });
  const client = w.t.withIdentity({ tokenIdentifier: `clerk|${name}`, name });
  await client.mutation(api.users.store, {});
  await client.mutation(api.invites.accept, { token: invite.token });
  const userId = (await client.query(api.users.me, {}))!._id;
  const member: any = await w.t.run(async (ctx: any) => (await ctx.db.query("members").collect()).find((m: any) => m.userId === userId));
  return { client, userId, memberId: member._id };
}

const wonToProject = [
  { type: "createRecord", object: "project", values: { name: "Delivery: {{record.name}}", company: "{{record.company}}", status: "active" } },
  { type: "createTask", title: "Kickoff call with {{record.name}}", dueInDays: 1, about: "trigger", values: { project: "{{created.project}}" } },
  { type: "createTask", title: "Send the welcome pack", dueInDays: 2, values: { project: "{{created.project}}" } },
  { type: "createTask", title: "First check-in", dueInDays: 7, values: { project: "{{created.project}}" } },
];
async function onWon(w: World, actions: unknown[] = wonToProject) {
  const id = await w.automation({ name: "Won deal to delivery", when: "fieldChanged", object: "opportunity", field: "stage", equals: "won", actions });
  await w.turnOn(id);
  return id;
}
const failingActions = [{ type: "createRecord", object: "project", values: { name: "P {{record.name}}" } }, { type: "createRecord", object: "project", values: { name: "Q", status: "{{record.name}}" } }];

describe("automations", () => {
  it("new and older workspaces get the Automation object, and a second seed changes nothing", async () => {
    const w = await world();
    expect(Object.keys(w.o.automation.fields)).toEqual(["name", "when", "object", "field", "equals", "offsetDays", "schedule", "actions", "status", "lastRun"]);
    expect(w.o.automation.fields.when.options.map((x: any) => x.id)).toEqual(["recordCreated", "fieldChanged", "dateReached", "schedule"]);
    expect(w.o.automation.fields.status.options.map((x: any) => x.id)).toEqual(["draft", "on", "paused"]);
    expect(w.o.automation.fields.lastRun).toMatchObject({ type: "date", withTime: true });
    const snapshot = () => w.t.run(async (ctx: any) => ({ objects: await ctx.db.query("objects").collect(), fields: await ctx.db.query("fields").collect() }));
    await w.t.run(async (ctx: any) => { for (const field of await ctx.db.query("fields").withIndex("by_object", (q: any) => q.eq("orgId", w.orgId).eq("objectId", w.o.automation.object._id)).collect()) await ctx.db.delete(field._id); await ctx.db.delete(w.o.automation.object._id); });
    await w.t.mutation(internal.seed.ensureStandard, { orgId: w.orgId });
    const once = await snapshot();
    expect(once.objects.filter((x: any) => x.key === "automation")).toHaveLength(1);
    await w.t.mutation(internal.seed.ensureStandard, { orgId: w.orgId });
    expect(await snapshot()).toEqual(once);
  });

  it("a new automation is a draft, an agent can draft and pause but never turn one on, and a person can", async () => {
    const w = await world();
    const agent = await agentFor(w.client, w.orgId, { name: "builder", grants: ["create", "update"].map((action: any) => ({ action, objectKey: "automation" })) });
    const call = rest(w.t, agent.key);
    const draft = await call("POST", "/api/v1/changes", { action: "create", object: "automation", values: { name: "Won deal to delivery", when: "fieldChanged", object: "opportunity", field: "stage", equals: "won", actions: JSON.stringify(wonToProject) }, reason: "draft" });
    expect(draft.status).toBe(200);
    expect(draft.json.record.values.status).toBe("draft");
    const id = draft.json.record.id;
    for (const path of ["/api/v1/changes", "/api/v1/suggestions"]) {
      const res = await call("POST", path, { action: "update", record: id, values: { status: "on" }, reason: "switch on" });
      expect(res.status).toBe(403);
      expect(res.json.error.message).toMatch(/only a person/i);
    }
    expect((await call("POST", "/api/v1/changes", { action: "create", object: "automation", values: { name: "Sneaky", status: "on" }, reason: "x" })).status).toBe(403);
    expect(await w.value("automation", id, "status")).toBe("draft");
    await w.turnOn(id);
    expect(await w.value("automation", id, "status")).toBe("on");
    const paused = await call("POST", "/api/v1/changes", { action: "update", record: id, values: { status: "paused" }, reason: "pause" });
    expect(paused.status).toBe(200);
    expect(await w.value("automation", id, "status")).toBe("paused");
  });

  it("editing what an on automation does pauses it; renaming it does not", async () => {
    const w = await world();
    const id = await onWon(w);
    await w.update("automation", id, { name: "Renamed" });
    expect(await w.value("automation", id, "status")).toBe("on");
    await w.update("automation", id, { equals: "lost" });
    expect(await w.value("automation", id, "status")).toBe("paused");
    await w.turnOn(id);
    const agent = await agentFor(w.client, w.orgId, { name: "builder", grants: [{ action: "update", objectKey: "automation" }] });
    expect((await rest(w.t, agent.key)("POST", "/api/v1/changes", { action: "update", record: id, values: { actions: JSON.stringify(wonToProject.slice(0, 1)) }, reason: "trim" })).status).toBe(200);
    expect(await w.value("automation", id, "status")).toBe("paused");
    const opp = await w.create("opportunity", { name: "Acme", stage: "proposal" });
    await w.update("opportunity", opp, { stage: "lost" });
    await w.drain();
    expect(await w.runs(id)).toEqual([]);
  });

  it("only a complete automation can be turned on", async () => {
    const w = await world();
    const id = await w.automation({ name: "Half done", when: "fieldChanged", object: "opportunity" });
    await expect(w.turnOn(id)).rejects.toMatchObject({ data: { code: "VALIDATION", message: expect.stringMatching(/field/i) } });
    await w.update("automation", id, { field: "stage" });
    await expect(w.turnOn(id)).rejects.toMatchObject({ data: { code: "VALIDATION", message: expect.stringMatching(/action/i) } });
    await expect(w.automation({ name: "Bad schedule", when: "schedule", schedule: "sometimes", actions: [{ type: "inbox", text: "hi" }] })).rejects.toMatchObject({ data: { code: "VALIDATION", message: expect.stringMatching(/daily HH:MM/) } });
    await expect(w.automation({ name: "Bad object", when: "recordCreated", object: "spaceship", actions: [{ type: "inbox", text: "hi" }] })).rejects.toMatchObject({ data: { code: "VALIDATION", message: expect.stringMatching(/spaceship/) } });
    await expect(w.automation({ name: "Bad tag", when: "recordCreated", object: "opportunity", actions: [{ type: "inbox", text: "{{record.nope}}" }] })).rejects.toMatchObject({ data: { code: "VALIDATION", message: expect.stringMatching(/nope/) } });
  });

  it("refuses actions that delete, send, publish or change an approval status, and more than 10 actions", async () => {
    const w = await world();
    const refused: [unknown[], RegExp][] = [
      [[{ type: "deleteRecord" }], /cannot delete/i],
      [[{ type: "sendEmail", to: "a@b.c" }], /cannot send/i],
      [[{ type: "webhook", url: "https://x.test" }], /cannot send/i],
      [[{ type: "createRecord", object: "email", values: { subject: "Hi", status: "approved" } }], /status/i],
      [[{ type: "updateTrigger", values: { status: "published" } }], /status/i],
      [[{ type: "createRecord", object: "automation", values: { name: "Spawn" } }], /automation/i],
      [[{ type: "updateTrigger", values: { amount: 5, nope: 1 } }], /nope/i],
      [[{ type: "launchRocket" }], /createRecord, updateTrigger, createTask, inbox or linkTrigger/],
      [Array.from({ length: 11 }, () => ({ type: "inbox", text: "x" })), /10/],
      ["not json" as any, /JSON/],
    ];
    for (const [actions, message] of refused) {
      const object = (actions as any)[0]?.values?.status === "published" ? "post" : "opportunity";
      const values = { name: "Bad", when: "recordCreated", object, actions: typeof actions === "string" ? actions : JSON.stringify(actions) };
      await expect(w.create("automation", values), String(message)).rejects.toMatchObject({ data: { code: "VALIDATION", message: expect.stringMatching(message) } });
    }
    expect(await w.all("automation")).toEqual([]);
  });

  it("when a deal is won, creates the delivery project and its three tasks once, as the automation for the person who turned it on", async () => {
    const w = await world();
    const id = await onWon(w);
    const acme = await w.create("company", { name: "Acme Plumbing" });
    const opp = await w.create("opportunity", { name: "Acme website", stage: "proposal", company: acme });
    await w.update("opportunity", opp, { amount: 5000 });
    await w.drain();
    expect(await w.runs(id)).toEqual([]);
    await w.update("opportunity", opp, { stage: "won" });
    await w.drain();
    const [project] = await w.all("project");
    expect(project).toMatchObject({ title: "Delivery: Acme website" });
    expect(await w.value("project", project._id, "company")).toBe(acme);
    const tasks = await w.all("task");
    expect(tasks.map((t: any) => t.title)).toEqual(["Kickoff call with Acme website", "Send the welcome pack", "First check-in"]);
    for (const task of tasks) expect(task.values[w.o.task.fields.project._id]).toBe(project._id);
    expect(tasks[0].values[w.o.task.fields.about._id]).toBe(opp);
    expect(tasks.map((t: any) => t.values[w.o.task.fields.dueDate._id])).toEqual([1, 2, 7].map((n) => Date.UTC(2026, 9, 5) + n * DAY));
    const [run] = await w.runs(id);
    const me = await w.client.query(api.users.me, {});
    expect(run).toMatchObject({ status: "done", triggerRecordId: opp, enabledBy: me!._id, depth: 1 });
    expect(run.created).toEqual([project._id, ...tasks.map((t: any) => t._id)]);
    const events: any[] = await w.t.run((ctx: any) => ctx.db.query("events").withIndex("by_record", (q: any) => q.eq("orgId", w.orgId).eq("recordId", project._id)).collect());
    expect(events[0].actor).toEqual({ kind: "automation", id });
    expect(events[0].reason).toMatch(/Won deal to delivery/);
    expect(await w.value("automation", id, "lastRun")).toBeGreaterThanOrEqual(start);
    // Back and forth: won to won is no change, lost is not a match, and winning again is a new event.
    await w.update("opportunity", opp, { stage: "won", name: "Acme website v2" });
    await w.update("opportunity", opp, { stage: "lost" });
    await w.drain();
    expect(await w.runs(id)).toHaveLength(1);
    await w.update("opportunity", opp, { stage: "won" });
    await w.drain();
    expect(await w.runs(id)).toHaveLength(2);
  });

  it("recordCreated fires once per created record, not on updates", async () => {
    const w = await world();
    const id = await w.automation({ name: "Welcome", when: "recordCreated", object: "company", actions: [{ type: "inbox", text: "New company {{record.name}}" }] });
    await w.turnOn(id);
    const acme = await w.create("company", { name: "Acme" });
    await w.update("company", acme, { city: "Springfield" });
    await w.create("opportunity", { name: "Not a company" });
    await w.drain();
    expect((await w.runs(id)).map((r: any) => r.status)).toEqual(["done"]);
    expect((await w.inbox()).map((i: any) => i.text)).toEqual(["New company Acme"]);
  });

  it("dateReached fires once on the day the offset lands on, however often the clock ticks", async () => {
    const w = await world();
    const id = await w.automation({ name: "Prep the day before", when: "dateReached", object: "opportunity", field: "closeDate", offsetDays: -1, actions: [{ type: "createTask", title: "Prep for {{record.name}}", dueInDays: 0, about: "trigger" }] });
    await w.turnOn(id);
    const tomorrow = await w.create("opportunity", { name: "Closing tomorrow", closeDate: Date.UTC(2026, 9, 6) });
    await w.create("opportunity", { name: "Closing later", closeDate: Date.UTC(2026, 9, 9) });
    await w.create("opportunity", { name: "No date" });
    await w.tick(); await w.tick();
    vi.setSystemTime(start + 6 * 3_600_000);
    await w.tick();
    expect((await w.all("task")).map((t: any) => t.title)).toEqual(["Prep for Closing tomorrow"]);
    expect((await w.runs(id)).map((r: any) => r.triggerRecordId)).toEqual([tomorrow]);
    vi.setSystemTime(start + DAY);
    await w.tick();
    expect(await w.runs(id)).toHaveLength(1);
  });

  it("a schedule fires once a day at its time, or once a week on its day, and not for times before it was turned on", async () => {
    const w = await world();
    const daily = await w.automation({ name: "Morning", when: "schedule", schedule: "daily 09:00", actions: [{ type: "inbox", text: "Check the board ({{today}})" }] });
    const weekly = await w.automation({ name: "Monday", when: "schedule", schedule: "weekly mon 08:00", actions: [{ type: "inbox", text: "Weekly review" }] });
    await w.turnOn(daily); await w.turnOn(weekly);
    await w.tick();
    expect(await w.runs()).toEqual([]);
    vi.setSystemTime(Date.UTC(2026, 9, 5, 9, 1));
    await w.tick(); await w.tick();
    expect((await w.inbox()).map((i: any) => i.text)).toEqual(["Check the board (2026-10-05)"]);
    vi.setSystemTime(Date.UTC(2026, 9, 6, 7));
    await w.tick();
    vi.setSystemTime(Date.UTC(2026, 9, 6, 9, 30));
    await w.tick();
    expect(await w.runs(daily)).toHaveLength(2);
    expect(await w.runs(weekly)).toEqual([]);
    vi.setSystemTime(Date.UTC(2026, 9, 12, 8, 5));
    await w.tick(); await w.tick();
    expect(await w.runs(weekly)).toHaveLength(1);
  });

  it("a run happens once even when its job is retried or ticks overlap", async () => {
    const w = await world();
    const id = await w.automation({ name: "Welcome", when: "recordCreated", object: "company", actions: [{ type: "createRecord", object: "project", values: { name: "Onboard {{record.name}}" } }] });
    await w.turnOn(id);
    await w.create("company", { name: "Acme" });
    await w.drain();
    const [run] = await w.runs(id);
    await w.t.action(internal.automations.run, { runId: run._id });
    await w.t.action(internal.automations.run, { runId: run._id });
    expect(await w.all("project")).toHaveLength(1);
    const daily = await w.automation({ name: "Morning", when: "schedule", schedule: "daily 08:40", actions: [{ type: "inbox", text: "Hi" }] });
    await w.turnOn(daily);
    vi.setSystemTime(Date.UTC(2026, 9, 5, 8, 41));
    await Promise.all([w.t.mutation(internal.automations.tick, {}), w.t.mutation(internal.automations.tick, {})]);
    await w.drain();
    expect(await w.runs(daily)).toHaveLength(1);
    expect(await w.inbox()).toHaveLength(1);
  });

  it("a run's own writes never trigger it again, and chains stop at depth 3", async () => {
    const w = await world();
    const self = await w.automation({ name: "Bump", when: "fieldChanged", object: "opportunity", field: "amount", actions: [{ type: "updateTrigger", values: { amount: 1 } }] });
    await w.turnOn(self);
    const opp = await w.create("opportunity", { name: "Loop", amount: 5 });
    await w.drain();
    expect(await w.value("opportunity", opp, "amount")).toBe(1);
    expect(await w.runs(self)).toHaveLength(1);
    await w.update("automation", self, { status: "paused" });
    const chain = [["company", "project", "Project for {{record.name}}"], ["project", "task", "Task for {{record.name}}"], ["task", "note", "Note for {{record.title}}"], ["note", "activity", "Activity for {{record.body}}"]];
    const ids = [];
    for (const [from, to, text] of chain) {
      const title = { project: "name", task: "title", note: "body", activity: "title" }[to]!;
      ids.push(await w.automation({ name: `${from} to ${to}`, when: "recordCreated", object: from, actions: [{ type: "createRecord", object: to, values: { [title]: text } }] }));
    }
    for (const id of ids) await w.turnOn(id);
    await w.create("company", { name: "Acme" });
    await w.drain();
    expect((await w.all("note")).map((n: any) => n.title)).toEqual(["Note for Task for Project for Acme"]);
    expect(await w.all("activity")).toEqual([]);
    const last = await w.runs(ids[3]);
    expect(last).toMatchObject([{ status: "skipped", depth: 4, error: expect.stringMatching(/3/) }]);
    expect((await w.runs(ids[2]))[0].depth).toBe(3);
  });

  it("nothing runs without the deployment's daily cap, and runs stop at the workspace cap and at 200 per automation", async () => {
    const w = await world();
    const id = await w.automation({ name: "Welcome", when: "recordCreated", object: "company", actions: [{ type: "inbox", text: "New {{record.name}}" }] });
    await w.turnOn(id);
    delete process.env.REMOLD_AUTOMATION_DAILY_CAP;
    await w.create("company", { name: "Uncapped" });
    await w.drain();
    expect(await w.inbox()).toEqual([]);
    expect(await w.runs(id)).toMatchObject([{ status: "skipped", error: expect.stringMatching(/daily limit/i) }]);
    process.env.REMOLD_AUTOMATION_DAILY_CAP = "2";
    for (const name of ["A", "B", "C"]) await w.create("company", { name });
    await w.drain();
    expect((await w.inbox()).map((i: any) => i.text)).toEqual(["New A", "New B"]);
    vi.setSystemTime(start + DAY);
    await w.create("company", { name: "Next day" });
    await w.drain();
    expect(await w.inbox()).toHaveLength(3);
    process.env.REMOLD_AUTOMATION_DAILY_CAP = "1000";
    vi.setSystemTime(start + 2 * DAY);
    await bulk(w.t, w.orgId, async (apply) => { for (let i = 0; i < 201; i++) await apply({ action: "create", objectId: w.o.company.object._id, values: { [w.o.company.fields.name._id]: `Bulk ${i}` } }); });
    await w.drain();
    const done = (await w.runs(id)).filter((r: any) => r._creationTime >= start + 2 * DAY && r.status === "done");
    expect(done).toHaveLength(200);
  });

  it("one write that sets off many runs schedules one job, and a queue whose job died is picked up by the cron", async () => {
    const w = await world();
    process.env.REMOLD_AUTOMATION_DAILY_CAP = "1000";
    const id = await w.automation({ name: "Welcome", when: "recordCreated", object: "company", actions: [{ type: "inbox", text: "New {{record.name}}" }] });
    await w.turnOn(id);
    await bulk(w.t, w.orgId, async (apply) => { for (let i = 0; i < 150; i++) await apply({ action: "create", objectId: w.o.company.object._id, values: { [w.o.company.fields.name._id]: `Bulk ${i}` } }); });
    const jobs = () => w.t.run(async (ctx: any) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((j: any) => j.name.includes("automations")));
    expect(await jobs()).toHaveLength(1);
    await w.drain();
    expect((await w.inbox()).map((i: any) => i.text).slice(0, 3)).toEqual(["New Bulk 0", "New Bulk 1", "New Bulk 2"]);
    expect((await w.runs(id)).filter((r: any) => r.status === "done")).toHaveLength(150);
    const state: any = await w.t.run((ctx: any) => ctx.db.query("automationState").first());
    await w.t.run((ctx: any) => ctx.db.insert("automationRuns", { orgId: w.orgId, automationId: id, key: "orphan", depth: 1, chain: [id], enabledBy: state.enabledBy, created: [], status: "queued" }));
    await w.tick();
    expect((await w.runs(id)).at(-1).status).toBe("queued");
    vi.setSystemTime(Date.now() + 11 * 60_000);
    await w.tick();
    expect((await w.runs(id)).at(-1).status).toBe("done");
  });

  it("acts with the permissions of the person who turned it on, and pauses when they lose them or the workspace is read only", async () => {
    const w = await world();
    const invite = await w.client.mutation(api.invites.create, { orgId: w.orgId, role: "admin" });
    const ben = w.t.withIdentity({ tokenIdentifier: "clerk|ben", name: "Ben" });
    await ben.mutation(api.users.store, {});
    await ben.mutation(api.invites.accept, { token: invite.token });
    const benId = (await ben.query(api.users.me, {}))!._id;
    const id = await w.automation({ name: "Welcome", when: "recordCreated", object: "company", actions: [{ type: "inbox", text: "New {{record.name}}" }] });
    await w.turnOn(id, ben);
    await w.create("company", { name: "Acme" });
    await w.drain();
    expect(await w.runs(id)).toMatchObject([{ status: "done", enabledBy: benId }]);
    // Queued before his role changed, run after: refused when it runs.
    await w.create("company", { name: "Queued before demotion" });
    await w.client.mutation(api.orgs.setRole, { orgId: w.orgId, userId: benId, role: "member" });
    await w.drain();
    expect((await w.runs(id)).map((r: any) => r.status)).toEqual(["done", "refused"]);
    expect(await w.value("automation", id, "status")).toBe("paused");
    await w.turnOn(id, ben);
    await w.client.mutation(api.orgs.setRole, { orgId: w.orgId, userId: benId, role: "admin" });
    // Changed again after turning it on: the next match queues no run and pauses it.
    await w.create("company", { name: "After promotion" });
    await w.drain();
    expect((await w.runs(id)).map((r: any) => r.status)).toEqual(["done", "refused"]);
    expect(await w.value("automation", id, "status")).toBe("paused");
    expect((await w.inbox()).filter((i: any) => /paused/i.test(i.text))).toHaveLength(2);
    // Turned on again by Ben, it works until he is removed.
    await w.turnOn(id, ben);
    await w.create("company", { name: "Fine" });
    await w.drain();
    await w.client.mutation(api.orgs.removeMember, { orgId: w.orgId, userId: benId });
    await w.create("company", { name: "Gone" });
    await w.drain();
    expect((await w.runs(id)).map((r: any) => r.status)).toEqual(["done", "refused", "done"]);
    expect(await w.value("automation", id, "status")).toBe("paused");
    await w.turnOn(id);
    await w.create("company", { name: "Before read only" });
    await w.t.run((ctx: any) => ctx.db.patch(w.orgId, { flags: { readonly: true } }));
    await w.drain();
    expect((await w.runs(id)).at(-1)).toMatchObject({ status: "refused", error: expect.stringMatching(/read only/i) });
    expect(await w.value("automation", id, "status")).toBe("paused");
  });

  it("a person cannot turn on an automation whose trigger reads what is hidden from them", async () => {
    const w = await world();
    const ben = await join(w, "Ben");
    // The verifier's probe: amount is hidden from Ben, so firing on its value would tell him what it is.
    await w.client.mutation(api.authority.policies.setMember, { orgId: w.orgId, memberId: ben.memberId, hiddenFieldIds: [w.o.opportunity.fields.amount._id, w.o.opportunity.fields.closeDate._id] });
    const big = await w.automation({ name: "Big deal", when: "fieldChanged", object: "opportunity", field: "amount", equals: "1000000", actions: [{ type: "inbox", text: "Big: {{record.name}} [{{record.amount}}]" }] });
    await expect(w.turnOn(big, ben.client)).rejects.toMatchObject({ data: { code: "FORBIDDEN", message: "To turn this on you need to see every opportunities and their amount, because it runs as you" } });
    for (const values of [{ when: "recordCreated", object: "opportunity", field: "amount", equals: "5" }, { when: "dateReached", object: "opportunity", field: "closeDate", offsetDays: 0 }]) {
      const id = await w.automation({ name: "Hidden", ...values, actions: [{ type: "inbox", text: "x" }] });
      await expect(w.turnOn(id, ben.client), values.when).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
    }
    const created = await w.automation({ name: "Any deal", when: "recordCreated", object: "opportunity", actions: [{ type: "inbox", text: "x" }] });
    await w.turnOn(created, ben.client);
    const opp = await w.create("opportunity", { name: "Acme", stage: "proposal", amount: 5 });
    await w.update("opportunity", opp, { amount: 1000000 });
    await w.drain();
    expect(await w.runs(big)).toEqual([]);
    expect(await w.value("automation", big, "status")).toBe("draft");
    // Scoped to automations only, Ben cannot turn on one that watches companies.
    await w.client.mutation(api.authority.policies.setMember, { orgId: w.orgId, memberId: ben.memberId, scopes: [{ objectId: w.o.automation.object._id, records: "all", fields: "all" }], hiddenFieldIds: [] });
    const companies = await w.automation({ name: "Companies", when: "recordCreated", object: "company", actions: [{ type: "inbox", text: "New {{record.name}}" }] });
    await expect(w.turnOn(companies, ben.client)).rejects.toMatchObject({ data: { code: "FORBIDDEN", message: expect.stringMatching(/every companies/) } });
  });

  it("a run is refused and the automation paused at once when the person can no longer read what it watches", async () => {
    const w = await world();
    const ben = await join(w, "Ben");
    const big = await w.automation({ name: "Big deal", when: "fieldChanged", object: "opportunity", field: "amount", actions: [{ type: "inbox", text: "Deal {{record.name}} changed" }] });
    await w.turnOn(big, ben.client);
    // An authority change that did not move Ben's epoch: the run checks what it reads itself.
    await w.t.run((ctx: any) => ctx.db.patch(ben.memberId, { hiddenFieldIds: [w.o.opportunity.fields.amount._id] }));
    for (const amount of [1, 2]) await w.create("opportunity", { name: `Deal ${amount}`, amount });
    await w.drain();
    expect(await w.runs(big)).toMatchObject([{ status: "refused", error: "Ben can no longer see every opportunities and their amount" }, { status: "skipped", error: "The automation was not on" }]);
    expect(await w.value("automation", big, "status")).toBe("paused");
    expect((await w.inbox()).map((i: any) => i.text)).toEqual(['Automation "Big deal" paused: Ben can no longer see every opportunities and their amount. Turn it on again to run it as you.']);
    // The same when his scope stops covering every opportunity.
    await w.t.run((ctx: any) => ctx.db.patch(ben.memberId, { hiddenFieldIds: [], readScopes: [{ objectId: w.o.opportunity.object._id, records: [], fields: "all" }, { objectId: w.o.automation.object._id, records: "all", fields: "all" }] }));
    await w.turnOn(big);
    await w.t.run(async (ctx: any) => { const state = await ctx.db.query("automationState").first(); await ctx.db.patch(state._id, { enabledBy: ben.userId, memberId: ben.memberId, epoch: 0 }); });
    await w.create("opportunity", { name: "Deal 3", amount: 3 });
    await w.drain();
    expect((await w.runs(big)).at(-1)).toMatchObject({ status: "refused", error: expect.stringMatching(/every opportunities/) });
    expect(await w.value("automation", big, "status")).toBe("paused");
  });

  it("fields hidden from the person it runs as read as empty in its templates and its dry run", async () => {
    const w = await world();
    const ben = await join(w, "Ben");
    await w.client.mutation(api.authority.policies.setMember, { orgId: w.orgId, memberId: ben.memberId, hiddenFieldIds: [w.o.opportunity.fields.amount._id] });
    const id = await w.automation({ name: "Won", when: "fieldChanged", object: "opportunity", field: "stage", equals: "won", actions: [{ type: "inbox", text: "Won {{record.name}} [{{record.amount}}]" }] });
    await w.turnOn(id, ben.client);
    const opp = await w.create("opportunity", { name: "Acme", stage: "proposal", amount: 5000 });
    // The dry run of an on automation renders as Ben; paused, it renders as the caller.
    const agent = await agentFor(w.client, w.orgId, { name: "reader" });
    const ref = (await w.read(id)).ref, oppRef = (await w.read(opp)).ref;
    const asBen = await rest(w.t, agent.key)("POST", `/api/v1/automations/${ref}/test`, { record: oppRef });
    expect(asBen.json).toMatchObject({ renderedAs: { who: "enabler", name: "Ben" }, steps: [{ action: "inbox", text: "Won Acme []" }] });
    await w.update("opportunity", opp, { stage: "won" });
    await w.drain();
    expect((await w.inbox()).map((i: any) => i.text)).toEqual(["Won Acme []"]);
    await w.client.mutation(api.automations.setOn, { orgId: w.orgId, recordId: id, on: false });
    const asCaller = await rest(w.t, agent.key)("POST", `/api/v1/automations/${ref}/test`, { record: oppRef });
    expect(asCaller.json).toMatchObject({ renderedAs: { who: "caller", name: "reader" }, steps: [{ action: "inbox", text: "Won Acme [5000]" }] });
  });

  it("the dry run never shows the caller a field or record it cannot read, even when it renders as the person who turned it on", async () => {
    const w = await world();
    // The verifier's probe P8: amount is masked from the agent, the automation is on as the owner.
    const id = await w.automation({ name: "Won", when: "fieldChanged", object: "opportunity", field: "stage", equals: "won", actions: [{ type: "inbox", text: "Won {{record.name}} [{{record.amount}}]" }, { type: "createRecord", object: "opportunity", values: { name: "Budget {{record.amount}}", amount: "{{record.amount}}" } }, { type: "updateTrigger", values: { amount: 7, name: "{{record.name}} (won)" } }] });
    await w.turnOn(id);
    const acme = await w.create("company", { name: "Acme Plumbing" });
    const opp = await w.create("opportunity", { name: "Acme", stage: "proposal", amount: 5000, company: acme });
    const agent = await agentFor(w.client, w.orgId, { name: "reader" });
    await w.client.mutation(api.authority.policies.setAgentMasks, { orgId: w.orgId, agentId: agent.agentId, hiddenFieldIds: [w.o.opportunity.fields.amount._id] });
    const call = rest(w.t, agent.key), ref = (await w.read(id)).ref, oppRef = (await w.read(opp)).ref;
    expect((await call("GET", `/api/v1/records/${oppRef}`)).json.record.values.amount).toBeUndefined();
    const test = await call("POST", `/api/v1/automations/${ref}/test`, { record: oppRef });
    expect(test.json.renderedAs).toEqual({ who: "enabler", name: "Owner" });
    expect(test.json.steps).toEqual([
      { action: "inbox", text: "Won Acme [(hidden from you)]" },
      { action: "create", object: "opportunity", values: { name: "Budget (hidden from you)", amount: "(hidden from you)" } },
      { action: "update", object: "opportunity", record: expect.objectContaining({ id: opp }), values: { amount: "(hidden from you)", name: "Acme (won)" } },
    ]);
    expect(JSON.stringify(test.json)).not.toContain("5000");
    // A caller that cannot read the record it names gets the same answer as a record that does not exist.
    const narrow = await agentFor(w.client, w.orgId, { name: "narrow" });
    await w.client.mutation(api.agents.setReadAccess, { orgId: w.orgId, agentId: narrow.agentId, readAllObjects: false, objectIds: [w.o.automation.object._id] });
    const refused = await rest(w.t, narrow.key)("POST", `/api/v1/automations/${ref}/test`, { record: oppRef });
    expect(refused.status).toBe(404);
    expect(JSON.stringify(refused.json)).not.toContain("Acme");
  });

  it("once the person it runs as has narrower access, matching writes queue no run and the automation pauses without naming the record", async () => {
    const w = await world();
    const ben = await join(w, "Ben");
    // The verifier's probe P7: Ben turns it on, then amount is hidden from him.
    const id = await w.automation({ name: "Big deal", when: "fieldChanged", object: "opportunity", field: "amount", equals: "1000000", actions: [{ type: "inbox", text: "Big: {{record.name}}" }] });
    await w.turnOn(id, ben.client);
    await w.client.mutation(api.authority.policies.setMember, { orgId: w.orgId, memberId: ben.memberId, hiddenFieldIds: [w.o.opportunity.fields.amount._id] });
    await w.create("opportunity", { name: "Small", stage: "proposal", amount: 5 });
    await w.create("opportunity", { name: "Secretly big", stage: "proposal", amount: 1000000 });
    await w.drain();
    expect(await w.runs(id)).toEqual([]);
    expect(await w.value("automation", id, "status")).toBe("paused");
    const view = await ben.client.query(api.automations.view, { orgId: w.orgId, recordId: id });
    expect(JSON.stringify(view)).not.toContain("Secretly big");
    expect((await w.inbox()).map((i: any) => i.text)).toEqual(['Automation "Big deal" paused: Ben no longer has the access they had when turning it on. Turn it on again to run it as you.']);
    // A run refused at run time keeps no trigger record either.
    const other = await w.automation({ name: "Any deal", when: "recordCreated", object: "opportunity", actions: [{ type: "inbox", text: "x" }] });
    await w.turnOn(other);
    const late = await w.create("opportunity", { name: "Refused one" });
    await w.t.run((ctx: any) => ctx.db.patch(w.orgId, { flags: { readonly: true } }));
    await w.drain();
    const [row] = await w.runs(other);
    expect(row).toMatchObject({ status: "refused" });
    expect(row.triggerRecordId).toBeUndefined();
    expect(row.eventId).toBeUndefined();
    expect(JSON.stringify(await w.client.query(api.automations.view, { orgId: w.orgId, recordId: other }))).not.toContain(late);
  });

  it("the dry run answers a record the caller cannot read the same way as one that does not exist, whatever its object", async () => {
    const w = await world();
    // The verifier's probe P9.
    const id = await w.automation({ name: "New deal", when: "recordCreated", object: "opportunity", actions: [{ type: "inbox", text: "x" }] });
    const company = await w.create("company", { name: "Acme Plumbing" });
    const opp = await w.create("opportunity", { name: "Acme", stage: "proposal" });
    const narrow = await agentFor(w.client, w.orgId, { name: "narrow" });
    await w.client.mutation(api.agents.setReadAccess, { orgId: w.orgId, agentId: narrow.agentId, readAllObjects: false, objectIds: [w.o.automation.object._id] });
    const call = rest(w.t, narrow.key), test = (record: string) => call("POST", `/api/v1/automations/${id}/test`, { record });
    const answers = [await test(company), await test(opp), await test("nope-nope-nope")];
    expect(answers.map((a) => [a.status, a.json.error.message])).toEqual([[404, "Record not found"], [404, "Record not found"], [404, "Record not found"]]);
    // A caller who can read it still learns the record is of the wrong object.
    const full = await agentFor(w.client, w.orgId, { name: "full" });
    expect((await rest(w.t, full.key)("POST", `/api/v1/automations/${id}/test`, { record: company })).status).toBe(400);
  });

  it("the dry run masks lookup titles and date arithmetic from fields and objects the caller cannot read", async () => {
    const w = await world();
    // The verifier's probe P10.
    const id = await w.automation({ name: "Won", when: "fieldChanged", object: "opportunity", field: "stage", equals: "won", actions: [
      { type: "createRecord", object: "project", values: { name: "For {{record.company}} by {{record.closeDate+1}}", company: "{{record.company}}" } },
      { type: "createTask", title: "Call {{record.company}}", dueInDays: 1, about: "trigger", values: { project: "{{created.project}}" } },
    ] });
    await w.turnOn(id);
    const company = await w.create("company", { name: "Acme Plumbing" });
    const opp = await w.create("opportunity", { name: "Acme", stage: "proposal", company, closeDate: Date.UTC(2026, 9, 5) });
    const agent = await agentFor(w.client, w.orgId, { name: "reader" });
    await w.client.mutation(api.agents.setReadAccess, { orgId: w.orgId, agentId: agent.agentId, readAllObjects: false, objectIds: [w.o.automation.object._id, w.o.opportunity.object._id, w.o.project.object._id] });
    await w.client.mutation(api.authority.policies.setAgentMasks, { orgId: w.orgId, agentId: agent.agentId, hiddenFieldIds: [w.o.opportunity.fields.closeDate._id] });
    const test = await rest(w.t, agent.key)("POST", `/api/v1/automations/${id}/test`, { record: opp });
    expect(test.status).toBe(200);
    expect(test.json.steps[0].values.name).toBe("For  by (hidden from you)");
    expect(JSON.stringify(test.json)).not.toContain("Acme Plumbing");
    expect(JSON.stringify(test.json)).not.toContain("2026-10-06");
  });

  it("a stale enabler's date automation pauses once with one inbox item, however many records are due", async () => {
    const w = await world();
    const ben = await join(w, "Ben");
    // The verifier's probe P11.
    const id = await w.automation({ name: "Due today", when: "dateReached", object: "opportunity", field: "closeDate", offsetDays: 0, actions: [{ type: "inbox", text: "Due {{record.name}}" }] });
    await w.turnOn(id, ben.client);
    for (const n of [1, 2, 3]) await w.create("opportunity", { name: `Deal ${n}`, stage: "proposal", closeDate: Date.UTC(2026, 9, 5) });
    await w.client.mutation(api.orgs.setRole, { orgId: w.orgId, userId: ben.userId, role: "member" });
    await w.tick();
    expect(await w.runs(id)).toEqual([]);
    expect(await w.value("automation", id, "status")).toBe("paused");
    expect((await w.inbox()).filter((i: any) => /paused/.test(i.text))).toHaveLength(1);
    const events: any[] = await w.t.run((ctx: any) => ctx.db.query("events").withIndex("by_record", (q: any) => q.eq("orgId", w.orgId).eq("recordId", id)).collect());
    expect(events.filter((e: any) => /paused/.test(e.reason ?? ""))).toHaveLength(1);
  });

  it("a run that fails writes nothing, and three failures in a row pause the automation with an inbox item", async () => {
    const w = await world();
    const id = await w.automation({ name: "Fragile", when: "recordCreated", object: "company", actions: failingActions });
    await w.turnOn(id);
    for (const name of ["A", "B"]) { await w.create("company", { name }); await w.drain(); }
    expect(await w.all("project")).toEqual([]);
    expect((await w.runs(id)).map((r: any) => r.status)).toEqual(["failed", "failed"]);
    expect((await w.runs(id))[0].error).toMatch(/Invalid select option/);
    expect(await w.value("automation", id, "status")).toBe("on");
    await w.create("company", { name: "C" });
    await w.drain();
    expect(await w.value("automation", id, "status")).toBe("paused");
    const [item] = await w.inbox();
    expect(item).toMatchObject({ source: "automation", recordId: id, text: expect.stringMatching(/Fragile.*paused/i) });
    await w.create("company", { name: "D" });
    await w.drain();
    expect(await w.runs(id)).toHaveLength(3);
  });

  it("a success between failures resets the count", async () => {
    const w = await world();
    const id = await w.automation({ name: "Fragile", when: "recordCreated", object: "company", actions: [{ type: "createRecord", object: "project", values: { name: "P", company: "{{record.city}}" } }] });
    await w.turnOn(id);
    const acme = await w.create("company", { name: "Acme" });
    for (const [name, city] of [["B1", "Atlantis"], ["B2", "Acme"], ["B3", "Atlantis"], ["B4", "Atlantis"]]) { await w.create("company", { name, city }); await w.drain(); }
    expect((await w.runs(id)).map((r: any) => r.status)).toEqual(["done", "failed", "done", "failed", "failed"]);
    expect(await w.value("automation", id, "status")).toBe("on");
    expect(acme).toBeTruthy();
  });

  it("the dry run shows what the actions would write for a record and writes nothing", async () => {
    const w = await world();
    const id = await onWon(w);
    const acme = await w.create("company", { name: "Acme Plumbing" });
    const opp = await w.create("opportunity", { name: "Acme website", stage: "proposal", company: acme });
    const agent = await agentFor(w.client, w.orgId, { name: "reader" });
    const ref = (await w.read(id)).ref, oppRef = (await w.read(opp)).ref;
    const dump = () => w.t.run(async (ctx: any) => Object.fromEntries(await Promise.all(["records", "events", "automationRuns", "agentInbox", "links", "automationState"].map(async (table) => [table, await ctx.db.query(table).collect()]))));
    const before = await dump();
    const res = await rest(w.t, agent.key)("POST", `/api/v1/automations/${ref}/test`, { record: oppRef });
    expect(res.status).toBe(200);
    expect(res.json.sentence).toBe("When an Opportunity's Stage becomes Won, create a Project and 3 Tasks");
    expect(res.json.steps[0]).toEqual({ action: "create", object: "project", values: { name: "Delivery: Acme website", company: { id: acme, ref: expect.any(String), title: "Acme Plumbing" }, status: "active" } });
    expect(res.json.steps[1]).toMatchObject({ action: "create", object: "task", values: { title: "Kickoff call with Acme website", dueDate: "2026-10-06", about: { id: opp }, project: "(the new Project)" } });
    expect(res.json.problems).toEqual([]);
    const bad = await w.automation({ name: "Fragile", when: "recordCreated", object: "company", actions: failingActions });
    const dry = await rest(w.t, agent.key)("POST", `/api/v1/automations/${(await w.read(bad)).ref}/test`, { record: (await w.read(acme)).ref });
    expect(dry.json.problems).toEqual([expect.stringMatching(/Invalid select option/)]);
    const after = await dump();
    after.records = after.records.filter((r: any) => r._id !== bad);
    after.events = after.events.filter((e: any) => e.recordId !== bad);
    expect(after).toEqual(before);
  });

  it("run history is readable by agents over REST and MCP, attributed to the trigger, the person and what was created", async () => {
    const w = await world();
    const id = await onWon(w);
    const opp = await w.create("opportunity", { name: "Acme website", stage: "proposal" });
    await w.update("opportunity", opp, { stage: "won" });
    await w.drain();
    const agent = await agentFor(w.client, w.orgId, { name: "reader" });
    const ref = (await w.read(id)).ref;
    const res = await rest(w.t, agent.key)("GET", `/api/v1/automations/${ref}/runs`);
    expect(res.status).toBe(200);
    expect(res.json.automation).toMatchObject({ id, status: "on", sentence: expect.stringMatching(/^When an Opportunity's Stage becomes Won/) });
    expect(res.json.runs).toEqual([expect.objectContaining({ status: "done", error: null, depth: 1, enabledBy: "Owner", trigger: expect.objectContaining({ id: opp, title: "Acme website" }), created: expect.arrayContaining([expect.objectContaining({ title: "Delivery: Acme website" })]) })]);
    expect(res.json.runs[0].created).toHaveLength(4);
    const fetchVia = (url: any, init: any) => w.t.fetch(new URL(url).pathname, init);
    const client = new RemoldClient({ url: "https://remold.test", key: agent.key, fetch: fetchVia as any });
    expect((await client.automationRuns(ref)).runs).toHaveLength(1);
    expect((await client.automationTest({ idOrRef: ref, record: opp })).steps).toHaveLength(4);
    const view = await w.client.query(api.automations.view, { orgId: w.orgId, recordId: id });
    expect(view).toMatchObject({ sentence: res.json.automation.sentence, status: "on", runs: [expect.objectContaining({ status: "done" })] });
  });

  it("runs from a cron every minute", () => {
    expect(Object.values((crons as any).crons)).toContainEqual(expect.objectContaining({ name: "automations:tick", schedule: { type: "cron", cron: "* * * * *" } }));
  });

  it("schedules and dates follow the workspace time zone, through the spring-forward change", async () => {
    const w = await world();
    await w.client.mutation(api.orgs.setTimeZone, { orgId: w.orgId, timeZone: "America/New_York" });
    // Saturday 2026-03-07 12:00 New York; clocks jump on the 8th at 02:00.
    vi.setSystemTime(Date.UTC(2026, 2, 7, 17));
    const daily = await w.automation({ name: "Morning", when: "schedule", schedule: "daily 09:00", actions: [{ type: "inbox", text: "Board ({{today}})" }] });
    await w.turnOn(daily);
    const closing = await w.automation({ name: "Closing today", when: "dateReached", object: "opportunity", field: "closeDate", actions: [{ type: "inbox", text: "Closing {{record.name}}" }] });
    await w.turnOn(closing);
    await w.create("opportunity", { name: "Acme", closeDate: Date.UTC(2026, 2, 8) });
    vi.setSystemTime(Date.UTC(2026, 2, 8, 12, 59)); // 08:59 EDT on the 8th; 09:00 EDT is 13:00 UTC, not the 14:00 UTC that 09:00 EST would be
    await w.tick();
    expect((await w.runs(daily)).length).toBe(0);
    vi.setSystemTime(Date.UTC(2026, 2, 8, 13, 1));
    await w.tick(); await w.tick();
    expect((await w.runs(daily)).length).toBe(1);
    expect((await w.inbox()).map((i: any) => i.text).sort()).toEqual(["Board (2026-03-08)", "Closing Acme"]);
    // Late on the 8th in UTC terms it is still the 8th in New York: nothing new fires, and the 9th starts at local midnight.
    vi.setSystemTime(Date.UTC(2026, 2, 9, 3, 59));
    await w.tick();
    expect((await w.runs(closing)).length).toBe(1);
    vi.setSystemTime(Date.UTC(2026, 2, 9, 13, 1));
    await w.tick(); await w.tick();
    expect((await w.runs(daily)).length).toBe(2);
    expect((await w.inbox()).map((i: any) => i.text)).toContain("Board (2026-03-09)");
  });
});
