import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import { api, agentFor, objectFields, rest, userAndOrg } from "./test.helpers";

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
    const items = await client.query(api.records.timeline, { orgId, recordId: acme });
    expect(items.map((i: any) => [i.kind, i.title]).sort()).toEqual([["activity", "Intro call"], ["note", "Met at the fair"], ["task", "Send proposal"]]);
    expect(items.find((i: any) => i.kind === "activity")).toMatchObject({ at: Date.UTC(2026, 8, 1, 15, 0), type: "Call", source: "manual" });
    expect(items.find((i: any) => i.kind === "task")).toMatchObject({ due: Date.UTC(2026, 9, 3, 18, 32), dueWithTime: true, done: false });
    const onTask = await client.query(api.records.timeline, { orgId, recordId: followUp });
    expect(onTask.map((i: any) => [i.kind, i.title])).toEqual([["note", "Draft sent, waiting on Ada"]]);
  });

  it("another workspace gets NOT_FOUND for a record timeline", async () => {
    const { client, orgId } = await userAndOrg();
    const other = await userAndOrg("B");
    const company = await objectFields(client, orgId, "company");
    const acme = (await client.mutation(api.records.create, { orgId, objectId: company.object._id, values: { [company.fields.name._id]: "Acme" } })).recordId;
    await expect(other.client.query(api.records.timeline, { orgId, recordId: acme })).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
  });
});
