import { describe, expect, it } from "vitest";
import { api, agentFor, objectFields, rest, userAndOrg } from "./test.helpers";

describe("time of day", () => {
  it("a task due at 14:32 with an offset reads back over REST at that instant, in UTC", async () => {
    const { t, client, orgId } = await userAndOrg();
    const agent = await agentFor(client, orgId, { name: "Clock", grants: [{ action: "create", objectKey: "task" }] });
    const call = rest(t, agent.key);
    const created = await call("POST", "/api/v1/changes", { action: "create", object: "task", values: { title: "Call Ada", dueDate: "2026-10-01T14:32:00-04:00" }, reason: "test" });
    expect(created.status).toBe(200);
    expect(created.json.record.values.dueDate).toBe("2026-10-01T18:32:00.000Z");
    const read = await call("GET", `/api/v1/records/${created.json.record.id}`);
    expect(read.json.record.values.dueDate).toBe("2026-10-01T18:32:00.000Z");
    const task = await objectFields(client, orgId, "task");
    expect(task.fields.dueDate.withTime).toBe(true);
    const stored = await client.query(api.records.get, { orgId, recordId: created.json.record.id });
    expect(stored!.record.values[task.fields.dueDate._id]).toBe(Date.UTC(2026, 9, 1, 18, 32));
  });

  it("a with-time field takes a plain date as midnight UTC and refuses a time without an offset", async () => {
    const { t, client, orgId } = await userAndOrg();
    const agent = await agentFor(client, orgId, { name: "Clock", grants: [{ action: "create", objectKey: "task" }] });
    const call = rest(t, agent.key);
    const plain = await call("POST", "/api/v1/changes", { action: "create", object: "task", values: { title: "All day", dueDate: "2026-10-02" }, reason: "test" });
    expect(plain.json.record.values.dueDate).toBe("2026-10-02");
    const floating = await call("POST", "/api/v1/changes", { action: "create", object: "task", values: { title: "Floating", dueDate: "2026-10-02T09:00" }, reason: "test" });
    expect(floating.status).toBe(400);
    expect(floating.json.error.fieldKey).toBe("dueDate");
  });

  it("plain date fields still truncate to the UTC day and read back as YYYY-MM-DD", async () => {
    const { t, client, orgId } = await userAndOrg();
    const agent = await agentFor(client, orgId, { name: "Clock", grants: [{ action: "create", objectKey: "opportunity" }] });
    const created = await rest(t, agent.key)("POST", "/api/v1/changes", { action: "create", object: "opportunity", values: { name: "Deal", closeDate: "2026-10-01T14:32:00-04:00" }, reason: "test" });
    expect(created.json.record.values.closeDate).toBe("2026-10-01");
    const deal = await objectFields(client, orgId, "opportunity");
    expect(deal.fields.closeDate.withTime).toBeUndefined();
  });

  it("settings can create a date field that keeps time, and only date fields can", async () => {
    const { client, orgId, objects } = await userAndOrg();
    const objectId = objects.find((o: any) => o.key === "project")!._id;
    await client.mutation(api.fields.create, { orgId, objectId, key: "kickoff", label: "Kickoff", type: "date", withTime: true });
    const project = await objectFields(client, orgId, "project");
    expect(project.fields.kickoff.withTime).toBe(true);
    await expect(client.mutation(api.fields.create, { orgId, objectId, key: "count", label: "Count", type: "number", withTime: true })).rejects.toMatchObject({ data: { code: "VALIDATION" } });
  });

  it("an explicit instant at exactly 00:00Z round-trips as that instant, distinct from a plain date on the same day", async () => {
    const { t, client, orgId } = await userAndOrg();
    const agent = await agentFor(client, orgId, { name: "Clock", grants: [{ action: "create", objectKey: "task" }] });
    const call = rest(t, agent.key);
    const midnight = await call("POST", "/api/v1/changes", { action: "create", object: "task", values: { title: "Midnight", dueDate: "2026-10-02T00:00:00Z" }, reason: "test" });
    const day = await call("POST", "/api/v1/changes", { action: "create", object: "task", values: { title: "Day", dueDate: "2026-11-30" }, reason: "test" });
    expect(midnight.json.record.values.dueDate).toBe("2026-10-02T00:00:00.000Z");
    expect(day.json.record.values.dueDate).toBe("2026-11-30");
    expect((await call("GET", `/api/v1/records/${midnight.json.record.id}`)).json.record.values.dueDate).toBe("2026-10-02T00:00:00.000Z");
    expect((await call("GET", `/api/v1/records/${day.json.record.id}`)).json.record.values.dueDate).toBe("2026-11-30");
  });

  it("the app accepts the stored encodings for with-time fields and refuses other fractions", async () => {
    const { client, orgId } = await userAndOrg();
    const task = await objectFields(client, orgId, "task"), f = task.fields;
    const instant = Date.UTC(2026, 9, 2) + 0.5;
    const { recordId } = await client.mutation(api.records.create, { orgId, objectId: task.object._id, values: { [f.title._id]: "Midnight", [f.dueDate._id]: instant } });
    expect((await client.query(api.records.get, { orgId, recordId }))!.record.values[f.dueDate._id]).toBe(instant);
    await expect(client.mutation(api.records.create, { orgId, objectId: task.object._id, values: { [f.title._id]: "Odd", [f.dueDate._id]: Date.UTC(2026, 9, 2, 5) + 0.25 } })).rejects.toMatchObject({ data: { code: "VALIDATION" } });
    const deal = await objectFields(client, orgId, "opportunity");
    await expect(client.mutation(api.records.create, { orgId, objectId: deal.object._id, values: { [deal.fields.name._id]: "Plain", [deal.fields.closeDate._id]: instant } })).rejects.toMatchObject({ data: { code: "VALIDATION" } });
  });
});
