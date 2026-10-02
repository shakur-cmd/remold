import { describe, expect, it } from "vitest";
import { anyApi } from "convex/server";
import { internal } from "./_generated/api";
import { api, agentFor, objectFields, rest, userAndOrg } from "./test.helpers";

async function timeline(client: any, orgId: any, recordId: any, numItems = 50) {
  const all: any[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 500; guard += 1) {
    const page: any = await client.query(api.events.timeline, { orgId, recordId, paginationOpts: { numItems, cursor } });
    all.push(...page.page);
    if (page.isDone) return all;
    cursor = page.continueCursor;
  }
  throw new Error("timeline did not finish");
}

const metadata = (t: any, orgId: any) => t.run(async (ctx: any) => ({
  objects: (await ctx.db.query("objects").withIndex("by_org", (q: any) => q.eq("orgId", orgId)).collect()),
  fields: (await ctx.db.query("fields").collect()).filter((f: any) => f.orgId === orgId),
}));

describe("activity and timeline", () => {
  it("new workspaces get Activity with type, when (with time), polymorphic about, and source", async () => {
    const { t, client, orgId } = await userAndOrg();
    const activity = await objectFields(client, orgId, "activity");
    expect(Object.keys(activity.fields)).toEqual(["title", "type", "when", "about", "source"]);
    expect(activity.fields.type.options.map((o: any) => o.id)).toEqual(["call", "email", "meeting", "payment", "message", "other"]);
    expect(activity.fields.when).toMatchObject({ type: "date", withTime: true });
    expect(activity.fields.about.type).toBe("lookup"); expect(activity.fields.about.targetObjectId).toBeUndefined();
    const agent = await agentFor(client, orgId, { name: "Logger", grants: [{ action: "create", objectKey: "activity" }, { action: "create", objectKey: "company" }] });
    const call = rest(t, agent.key);
    const company = await call("POST", "/api/v1/changes", { action: "create", object: "company", values: { name: "Acme" }, reason: "test" });
    const logged = await call("POST", "/api/v1/changes", { action: "create", object: "activity", values: { title: "Intro call", type: "call", when: "2026-10-01T14:32:00-04:00", about: company.json.record.id, source: "manual" }, reason: "test" });
    expect(logged.status).toBe(200);
    expect(logged.json.record.values).toMatchObject({ type: "call", when: "2026-10-01T18:32:00.000Z", about: { id: company.json.record.id }, source: "manual" });
  });

  it("the migration adds Activity and task due time to an older workspace, and a second run changes nothing", async () => {
    const { t, orgId } = await userAndOrg();
    await t.run(async (ctx: any) => {
      const activity = await ctx.db.query("objects").withIndex("by_org_key", (q: any) => q.eq("orgId", orgId).eq("key", "activity")).unique();
      for (const field of await ctx.db.query("fields").withIndex("by_object", (q: any) => q.eq("orgId", orgId).eq("objectId", activity._id)).collect()) await ctx.db.delete(field._id);
      await ctx.db.delete(activity._id);
      const task = await ctx.db.query("objects").withIndex("by_org_key", (q: any) => q.eq("orgId", orgId).eq("key", "task")).unique();
      const due = await ctx.db.query("fields").withIndex("by_object_key", (q: any) => q.eq("orgId", orgId).eq("objectId", task._id).eq("key", "dueDate")).unique();
      await ctx.db.replace(due._id, (({ _id, _creationTime, withTime, ...rest }: any) => rest)(due));
    });
    const old = await metadata(t, orgId);
    expect(old.objects.some((o: any) => o.key === "activity")).toBe(false);
    await t.mutation(internal.seed.ensureStandard, { orgId });
    const once = await metadata(t, orgId);
    expect(once.objects.some((o: any) => o.key === "activity")).toBe(true);
    const taskId = once.objects.find((o: any) => o.key === "task")._id;
    expect(once.fields.find((f: any) => f.objectId === taskId && f.key === "dueDate").withTime).toBe(true);
    // Only additions: every field that existed before is unchanged apart from the new flag.
    for (const before of old.fields) expect((({ withTime, ...rest }: any) => rest)(once.fields.find((f: any) => f._id === before._id))).toEqual(before);
    await t.mutation(internal.seed.ensureStandard, { orgId });
    expect(await metadata(t, orgId)).toEqual(once);
  });

  it("a record's timeline lists activities, notes and tasks about it, and a task's own notes show on the task", async () => {
    const { client, orgId } = await userAndOrg();
    const [company, task, note, activity] = await Promise.all(["company", "task", "note", "activity"].map((key) => objectFields(client, orgId, key)));
    const create = async (item: any, values: Record<string, unknown>) => (await client.mutation(api.records.create, { orgId, objectId: item.object._id, values: Object.fromEntries(Object.entries(values).map(([k, v]) => [item.fields[k]._id, v])) })).recordId;
    const acme = await create(company, { name: "Acme" });
    const followUp = await create(task, { title: "Send proposal", about: acme, dueDate: Date.UTC(2026, 9, 3, 18, 32) });
    await create(note, { body: "Met at the fair", about: acme });
    await create(activity, { title: "Intro call", type: "call", when: Date.UTC(2026, 8, 1, 15, 0), about: acme, source: "manual" });
    await create(note, { body: "Draft sent, waiting on Ada", about: followUp });
    const items = (await timeline(client, orgId, acme)).filter((i: any) => i.kind !== "event");
    expect(items.map((i: any) => [i.kind, i.title]).sort()).toEqual([["activity", "Intro call"], ["note", "Met at the fair"], ["task", "Send proposal"]]);
    expect(items.find((i: any) => i.kind === "activity")).toMatchObject({ at: Date.UTC(2026, 8, 1, 15, 0), type: "Call", source: "manual" });
    expect(items.find((i: any) => i.kind === "task")).toMatchObject({ due: Date.UTC(2026, 9, 3, 18, 32), dueWithTime: true, done: false });
    const onTask = (await timeline(client, orgId, followUp)).filter((i: any) => i.kind !== "event");
    expect(onTask.map((i: any) => [i.kind, i.title])).toEqual([["note", "Draft sent, waiting on Ada"]]);
  });

  it("pages the merged timeline newest first: activities by when, everything else by when it happened, with no gaps or repeats", async () => {
    const { t, client, orgId } = await userAndOrg();
    const [company, task, note, activity] = await Promise.all(["company", "task", "note", "activity"].map((key) => objectFields(client, orgId, key)));
    const create = async (item: any, values: Record<string, unknown>) => (await client.mutation(api.records.create, { orgId, objectId: item.object._id, values: Object.fromEntries(Object.entries(values).map(([k, v]) => [item.fields[k]._id, v])) })).recordId;
    const acme = await create(company, { name: "Acme" });
    const ids = [acme, await create(note, { body: "First note", about: acme }),
      await create(activity, { title: "Old call", type: "call", when: Date.UTC(2020, 0, 1, 15), about: acme }),
      await create(activity, { title: "Undated email", type: "email", about: acme }),
      await create(task, { title: "Follow up", about: acme }),
      await create(activity, { title: "Planned meeting", type: "meeting", when: Date.UTC(2030, 0, 1), about: acme }),
      await create(activity, { title: "Same-day call", type: "call", when: Date.UTC(2030, 0, 1), about: acme })];
    await client.mutation(api.records.update, { orgId, recordId: acme, values: { [company.fields.city._id]: "Baltimore" } });
    const expected = [["activity", "Same-day call"], ["activity", "Planned meeting"], ["event", "update"], ["task", "Follow up"], ["activity", "Undated email"], ["note", "First note"], ["event", "create"], ["activity", "Old call"]];
    const label = (i: any) => [i.kind, i.kind === "event" ? i.action : i.title];
    for (const size of [1, 2, 3, 50]) {
      const all = await timeline(client, orgId, acme, size);
      expect(all.map(label), `page size ${size}`).toEqual(expected);
      expect(new Set(all.map((i: any) => i._id)).size).toBe(all.length);
    }
    // A member limited to named records is served from their list and sees the same order.
    const memberId = await t.run(async (ctx: any) => (await ctx.db.query("members").collect())[0]._id);
    const byObject = new Map<string, string[]>();
    for (const id of ids) { const r: any = await client.query(api.records.get, { orgId, recordId: id }); byObject.set(r.object._id, [...(byObject.get(r.object._id) ?? []), id]); }
    await client.mutation(anyApi["authority/policies"].setMember, { orgId, memberId, hiddenFieldIds: [], scopes: [...byObject].map(([objectId, records]) => ({ objectId, records, fields: "all" })) });
    expect((await timeline(client, orgId, acme, 2)).map(label)).toEqual(expected);
  });

  it("every related note stays reachable: 201 notes page through to the first", async () => {
    const { client, orgId } = await userAndOrg();
    const [company, note] = await Promise.all(["company", "note"].map((key) => objectFields(client, orgId, key)));
    const acme = (await client.mutation(api.records.create, { orgId, objectId: company.object._id, values: { [company.fields.name._id]: "Acme" } })).recordId;
    for (let i = 0; i < 201; i += 1) await client.mutation(api.records.create, { orgId, objectId: note.object._id, values: { [note.fields.body._id]: `Note ${i}`, [note.fields.about._id]: acme } });
    const notes = (await timeline(client, orgId, acme, 40)).filter((i: any) => i.kind === "note").map((i: any) => i.title);
    expect(notes).toEqual(Array.from({ length: 201 }, (_, i) => `Note ${200 - i}`));
  });

  it("another workspace gets NOT_FOUND for a record timeline", async () => {
    const { client, orgId } = await userAndOrg();
    const other = await userAndOrg("B");
    const company = await objectFields(client, orgId, "company");
    const acme = (await client.mutation(api.records.create, { orgId, objectId: company.object._id, values: { [company.fields.name._id]: "Acme" } })).recordId;
    await expect(other.client.query(api.events.timeline, { orgId, recordId: acme, paginationOpts: { numItems: 10, cursor: null } })).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
  });
});
