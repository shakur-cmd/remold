import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import { agentFor, api, objectFields, rest, userAndOrg } from "./test.helpers";

const DAY = 86_400_000, now = Date.UTC(2026, 9, 1, 15), today = Date.UTC(2026, 9, 1);
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => vi.useRealTimers());

// An owner "Ada" with a second member "Ben" and an agent "Scout" that may create and update tasks.
async function workspace() {
  const base = await userAndOrg("Ada"), { t, client, orgId } = base;
  const invite = await client.mutation(api.invites.create, { orgId, role: "member" });
  const ben = t.withIdentity({ tokenIdentifier: "clerk|Ben", name: "Ben" });
  await ben.mutation(api.users.store, {});
  await ben.mutation(api.invites.accept, { token: invite.token });
  const people = await client.query(api.orgs.members, { orgId });
  const id = (name: string) => people.find((p: any) => p.user.name === name)!.user._id as string;
  const scout = await agentFor(client, orgId, { name: "Scout", grants: [{ action: "create", objectKey: "task" }, { action: "update", objectKey: "task" }] });
  const other = await agentFor(client, orgId, { name: "Other", grants: [{ action: "create", objectKey: "task" }] });
  const task = await objectFields(client, orgId, "task");
  const add = async (title: string, values: Record<string, unknown> = {}) => {
    const byKey = Object.fromEntries(Object.entries({ title, ...values }).map(([k, v]) => [task.fields[k]._id, v]));
    return (await client.mutation(api.records.create, { orgId, objectId: task.object._id, values: byKey })).recordId;
  };
  const set = (recordId: any, values: Record<string, unknown>, who = client) => who.mutation(api.records.update, { orgId, recordId, values: Object.fromEntries(Object.entries(values).map(([k, v]) => [task.fields[k]._id, v])) });
  return { ...base, ben, id, ada: id("Ada"), benId: id("Ben"), scout, other, task, add, set, scoutCall: rest(t, scout.key), otherCall: rest(t, other.key) };
}
const titles = (rows: any[]) => rows.map((r) => r.title);

describe("task assignee", () => {
  it("is a standard task field, added once however often the standard objects are ensured", async () => {
    const { t, client, orgId, task } = await workspace();
    expect(task.fields.assignee).toMatchObject({ type: "text", retired: false });
    const count = async () => (await t.run(async (ctx: any) => (await ctx.db.query("fields").collect()).filter((f: any) => f.objectId === task.object._id && f.key === "assignee"))).length;
    expect(await count()).toBe(1);
    // An older workspace made before the field existed gains it, once.
    await t.run(async (ctx: any) => ctx.db.delete(task.fields.assignee._id));
    expect(await count()).toBe(0);
    await t.mutation(internal.seed.ensureStandard, { orgId });
    await t.mutation(internal.seed.ensureStandard, { orgId });
    expect(await count()).toBe(1);
    void client;
  });

  it("shows the person's or agent's name over REST, and filters by name or id", async () => {
    const { client, ben, benId, scout, ada, add, set, scoutCall } = await workspace();
    const a = await add("For Ben"), b = await add("For Scout"), c = await add("Nobody's");
    await set(a, { assignee: benId }); await set(b, { assignee: scout.agentId });
    void ben; void ada; void c;
    const read = await scoutCall("GET", `/api/v1/records/${a}`);
    expect(read.json.record.values.assignee).toEqual({ id: benId, name: "Ben", kind: "person" });
    expect((await scoutCall("GET", `/api/v1/records/${b}`)).json.record.values.assignee).toEqual({ id: scout.agentId, name: "Scout", kind: "agent" });
    expect((await scoutCall("GET", `/api/v1/records/${c}`)).json.record.values.assignee).toBeUndefined();
    const byName = await scoutCall("GET", "/api/v1/records?object=task&filter=assignee&value=Ben");
    expect(titles(byName.json.records)).toEqual(["For Ben"]);
    const byId = await scoutCall("GET", `/api/v1/records?object=task&filter=assignee&value=${scout.agentId}`);
    expect(titles(byId.json.records)).toEqual(["For Scout"]);
    void client;
  });

  it("lists the people and active agents a task can go to", async () => {
    const { client, orgId, benId, ada, scout, other } = await workspace();
    const list = await client.query(api.queue.assignees, { orgId });
    expect(list).toEqual(expect.arrayContaining([{ id: ada, name: "Ada", kind: "person" }, { id: benId, name: "Ben", kind: "person" }, { id: scout.agentId, name: "Scout", kind: "agent" }, { id: other.agentId, name: "Other", kind: "agent" }]));
  });

  it("refuses an assignee who is not in this workspace", async () => {
    const { t, client, orgId, task, add } = await workspace();
    const stranger = t.withIdentity({ tokenIdentifier: "clerk|Zed", name: "Zed" });
    await stranger.mutation(api.users.store, {});
    await stranger.mutation(api.orgs.create, { name: "Zed Org" });
    const zed = (await t.run(async (ctx: any) => (await ctx.db.query("users").collect()).find((u: any) => u.name === "Zed")))._id;
    const id = await add("Mine");
    for (const assignee of [zed, "nobody", "Mars"]) await expect(client.mutation(api.records.update, { orgId, recordId: id, values: { [task.fields.assignee._id]: assignee } })).rejects.toThrow();
  });

  it("lets an agent take a task, leave it, or hand it to a person, but not give it to another agent", async () => {
    const { client, orgId, scout, other, benId, add, scoutCall } = await workspace();
    const id = await add("Shared");
    const change = (assignee: unknown) => scoutCall("POST", "/api/v1/changes", { action: "update", record: id, values: { assignee }, reason: "x" });
    expect((await change(scout.agentId)).status).toBe(200);
    expect((await change(other.agentId)).status).toBe(403);
    expect((await change("Other")).status).toBe(403);
    expect((await change(benId)).status).toBe(200);
    expect((await change(null)).status).toBe(200);
    void client; void orgId;
  });

  it("writes a handoff event naming who gave the task to whom", async () => {
    const { client, orgId, benId, scout, add, set, task } = await workspace();
    const id = await add("Hand off");
    await set(id, { assignee: scout.agentId });
    await set(id, { assignee: benId });
    const [handoff, taken] = await client.query(api.events.forRecord, { orgId, recordId: id });
    expect(handoff).toMatchObject({ action: "update", actorName: "Ada", before: { [task.fields.assignee._id]: scout.agentId }, after: { [task.fields.assignee._id]: benId } });
    expect(taken!.after).toMatchObject({ [task.fields.assignee._id]: scout.agentId });
  });

  it("records an agent's handoff to a person as the agent's event", async () => {
    const { client, orgId, benId, scout, add, scoutCall } = await workspace();
    const id = await add("From the agent");
    await scoutCall("POST", "/api/v1/changes", { action: "update", record: id, values: { assignee: "Ben" }, reason: "needs a person" });
    const [event] = await client.query(api.events.forRecord, { orgId, recordId: id });
    expect(event).toMatchObject({ actor: { kind: "agent", id: scout.agentId }, reason: "needs a person" });
    expect(Object.values(event!.after!)).toContain(benId);
  });
});

describe("Mine and Waiting on others", () => {
  it("shows a person their ready tasks, due and overdue first then undated, and nobody else's", async () => {
    const { client, orgId, ada, benId, add, set } = await workspace();
    const later = await add("Undated"), overdue = await add("Overdue", { dueDate: today - 3 * DAY }), soon = await add("Due today", { dueDate: today }), theirs = await add("Ben's", { dueDate: today }), loose = await add("Unassigned", { dueDate: today });
    for (const id of [later, overdue, soon]) await set(id, { assignee: ada });
    await set(theirs, { assignee: benId });
    const data = await client.query(api.today.get, { orgId });
    expect(titles(data.mine)).toEqual(["Overdue", "Due today", "Undated"]);
    expect(titles(data.tasks)).toEqual(expect.arrayContaining(["Unassigned", "Ben's"]));
    void loose;
  });

  it("shows an agent only the tasks assigned to it", async () => {
    const { client, orgId, benId, ada, scout, other, add, set, scoutCall, otherCall } = await workspace();
    const a = await add("Scout's own", { dueDate: today }), b = await add("Other's own", { dueDate: today }), c = await add("Ada's", { dueDate: today }), d = await add("Ben's", { dueDate: today });
    await set(a, { assignee: scout.agentId }); await set(b, { assignee: other.agentId }); await set(c, { assignee: ada }); await set(d, { assignee: benId });
    expect(titles((await scoutCall("GET", "/api/v1/today")).json.mine)).toEqual(["Scout's own"]);
    expect(titles((await otherCall("GET", "/api/v1/today")).json.mine)).toEqual(["Other's own"]);
    expect(titles((await client.query(api.today.get, { orgId })).mine)).toEqual(["Ada's"]);
  });

  it("holds back a task until everything it is blocked by is done, down a chain", async () => {
    const { client, orgId, ada, add, set } = await workspace();
    const c = await add("C first", { assignee: ada }), b = await add("B second", { assignee: ada }), a = await add("A last", { assignee: ada });
    await set(b, { blockedBy: [c] }); await set(a, { blockedBy: [b] });
    const view = async () => { const d = await client.query(api.today.get, { orgId }); return { mine: titles(d.mine), waiting: d.waiting.map((w: any) => [w.record.title, w.on.map((x: any) => x.title)]) }; };
    expect(await view()).toEqual({ mine: ["C first"], waiting: [["B second", ["C first"]], ["A last", ["B second"]]] });
    await set(c, { done: true });
    expect(await view()).toEqual({ mine: ["B second"], waiting: [["A last", ["B second"]]] });
    await set(b, { done: true });
    expect(await view()).toEqual({ mine: ["A last"], waiting: [] });
  });

  it("stays blocked until every blocker is done, and names only the ones still open", async () => {
    const { client, orgId, ada, add, set } = await workspace();
    const x = await add("X"), y = await add("Y"), z = await add("Z", { assignee: ada });
    await set(z, { blockedBy: [x, y] });
    await set(x, { done: true });
    let data = await client.query(api.today.get, { orgId });
    expect(titles(data.mine)).toEqual([]);
    expect(data.waiting[0].on.map((o: any) => o.title)).toEqual(["Y"]);
    await set(y, { done: true });
    data = await client.query(api.today.get, { orgId });
    expect(titles(data.mine)).toEqual(["Z"]);
  });

  it("leaves finished tasks out of both lists", async () => {
    const { client, orgId, ada, add, set } = await workspace();
    const open = await add("Open", { assignee: ada }), finished = await add("Finished", { assignee: ada });
    await set(finished, { done: true });
    const data = await client.query(api.today.get, { orgId });
    expect(titles(data.mine)).toEqual(["Open"]);
    void open;
  });

  it("shows an agent its blocked task with the task that blocks it", async () => {
    const { add, set, scout, scoutCall, ada } = await workspace();
    const blocker = await add("Get the logo", { assignee: ada }), mine = await add("Post the launch", { assignee: scout.agentId });
    await set(mine, { blockedBy: [blocker] });
    const today = (await scoutCall("GET", "/api/v1/today")).json;
    expect(today.mine).toEqual([]);
    expect(today.waiting).toHaveLength(1);
    expect(today.waiting[0].task.title).toBe("Post the launch");
    expect(today.waiting[0].waitingOn).toEqual([expect.objectContaining({ title: "Get the logo" })]);
  });

  it("pages an agent's own ready tasks over REST", async () => {
    const { add, set, scout, scoutCall } = await workspace();
    for (const n of [1, 2, 3]) await set(await add(`Task ${n}`, { dueDate: today + n * DAY }), { assignee: scout.agentId });
    const first = await scoutCall("GET", "/api/v1/my-tasks?limit=2");
    expect(titles(first.json.records)).toEqual(["Task 1", "Task 2"]);
    expect(first.json.cursor).toBeTruthy();
    const second = await scoutCall("GET", `/api/v1/my-tasks?limit=2&cursor=${encodeURIComponent(first.json.cursor)}`);
    expect(titles(second.json.records)).toEqual(["Task 3"]);
    expect(second.json.cursor).toBeNull();
  });
});

describe("Today in the workspace's time zone", () => {
  it("counts a task due at 22:00 New York time as due on that local day even after UTC has rolled over", async () => {
    const { client, orgId, add } = await workspace();
    vi.setSystemTime(Date.UTC(2026, 9, 3, 3));
    await add("Late call", { dueDate: Date.UTC(2026, 9, 3, 2) + 0.0 });
    const utcView = await client.query(api.today.get, { orgId });
    expect(utcView.days[utcView.tasks[0]._id]).toBe(Date.UTC(2026, 9, 3));
    await client.mutation(api.orgs.setTimeZone, { orgId, timeZone: "America/New_York" });
    const local = await client.query(api.today.get, { orgId });
    expect(local.day.today).toBe(Date.UTC(2026, 9, 2));
    expect(local.days[local.tasks[0]._id]).toBe(Date.UTC(2026, 9, 2));
  });

  it("starts the next day at local midnight across the spring-forward change", async () => {
    const { client, orgId, add } = await workspace();
    await client.mutation(api.orgs.setTimeZone, { orgId, timeZone: "America/New_York" });
    // 2026-03-08: clocks jump at 02:00, so the day is 23 hours and midnight to midnight is 05:00Z to 04:00Z.
    await add("Last minute", { dueDate: Date.UTC(2026, 2, 9, 3, 59) });
    await add("First minute", { dueDate: Date.UTC(2026, 2, 9, 4, 0) });
    vi.setSystemTime(Date.UTC(2026, 2, 8, 16));
    const data = await client.query(api.today.get, { orgId });
    expect(data.day).toEqual({ zone: "America/New_York", today: Date.UTC(2026, 2, 8), start: Date.UTC(2026, 2, 8, 5), end: Date.UTC(2026, 2, 9, 4) - 1 });
    const dayOf = Object.fromEntries(data.tasks.map((r: any) => [r.title, data.days[r._id]]));
    expect(dayOf).toEqual({ "Last minute": Date.UTC(2026, 2, 8), "First minute": Date.UTC(2026, 2, 9) });
  });

  it("gives an agent the same local day", async () => {
    const { client, orgId, scoutCall } = await workspace();
    await client.mutation(api.orgs.setTimeZone, { orgId, timeZone: "Pacific/Auckland" });
    vi.setSystemTime(Date.UTC(2026, 9, 3, 12));
    expect((await scoutCall("GET", "/api/v1/today")).json.day).toMatchObject({ zone: "Pacific/Auckland", date: "2026-10-04" });
  });
});
