import { describe, expect, it } from "vitest";
import { agentFor, api, objectFields, rest, userAndOrg } from "./test.helpers";

describe("agent REST", () => {
  it("isolates agent keys and proposes without writing", async () => {
    const first = await userAndOrg("First"), second = await userAndOrg("Second");
    const company = await objectFields(first.client, first.orgId, "company"), opportunity = await objectFields(first.client, first.orgId, "opportunity");
    const created = await first.client.mutation(api.records.create, { orgId: first.orgId, objectId: opportunity.object._id, values: { [opportunity.fields.name._id]: "Deal", [opportunity.fields.stage._id]: "new" } });
    await second.client.mutation(api.records.create, { orgId: second.orgId, objectId: (await objectFields(second.client, second.orgId, "company")).object._id, values: { [(await objectFields(second.client, second.orgId, "company")).fields.name._id]: "Other" } });
    const agent = await agentFor(first.client, first.orgId, { name: "agent" }), call = rest(first.t, agent.key);
    expect((await first.t.fetch("/api/v1/me")).status).toBe(401);
    expect((await call("GET", "/api/v1/records?object=company")).json.records).toEqual([]);
    const before = await first.client.query(api.events.forRecord, { orgId: first.orgId, recordId: created.recordId });
    const proposed = await call("POST", "/api/v1/suggestions", { action: "update", record: (await first.client.query(api.records.get, { orgId: first.orgId, recordId: created.recordId }))!.record.ref, values: { stage: "Won" }, reason: "qualified" });
    expect(proposed.status).toBe(201);
    expect(proposed.json.suggestion.before.stage).toBe("new");
    expect((await first.client.query(api.records.get, { orgId: first.orgId, recordId: created.recordId }))!.record.values[opportunity.fields.stage._id]).toBe("new");
    expect(await first.client.query(api.events.forRecord, { orgId: first.orgId, recordId: created.recordId })).toEqual(before);
    void company;
  });
  it("uses grants, resolves friendly values, and attributes the agent", async () => {
    const { client, orgId, t } = await userAndOrg();
    const company = await objectFields(client, orgId, "company"), task = await objectFields(client, orgId, "task");
    const companyRecord = await client.mutation(api.records.create, { orgId, objectId: company.object._id, values: { [company.fields.name._id]: "Atlas" } });
    const noGrant = await agentFor(client, orgId, { name: "read-only" }), denied = await rest(t, noGrant.key)("POST", "/api/v1/changes", { action: "update", record: companyRecord.recordId, values: { city: "Boston" }, reason: "x" });
    expect(denied.status).toBe(403);
    const agent = await agentFor(client, orgId, { name: "writer", grants: [{ action: "create", objectKey: "task" }] }), call = rest(t, agent.key);
    const companyDetail = await client.query(api.records.get, { orgId, recordId: companyRecord.recordId });
    const result = await call("POST", "/api/v1/changes", { action: "create", object: "task", values: { title: "Call back", dueDate: "2026-10-01", about: companyDetail!.record.ref }, reason: "follow up" });
    expect(result.status).toBe(200);
    const record = await client.query(api.records.get, { orgId, recordId: result.json.record.id });
    expect(record!.record.createdBy).toBe(agent.agentId);
    expect(record!.record.values[task.fields.about._id]).toBe(companyRecord.recordId);
    expect((await client.query(api.events.forRecord, { orgId, recordId: result.json.record.id }))[0]?.actor).toMatchObject({ kind: "agent", id: agent.agentId });
    expect((await call("POST", "/api/v1/changes", { action: "create", object: "task", values: { title: "No", dueDate: "bad" }, reason: "bad" })).status).toBe(400);
  });
});

describe("agent REST edges", () => {
  it("filters by a select label, rejects a bad body with 400, and hides internals", async () => {
    const { client, orgId, t } = await userAndOrg();
    const opportunity = await objectFields(client, orgId, "opportunity");
    for (const [name, stage] of [["Won deal", "won"], ["Open deal", "new"]]) await client.mutation(api.records.create, { orgId, objectId: opportunity.object._id, values: { [opportunity.fields.name._id]: name, [opportunity.fields.stage._id]: stage } });
    const agent = await agentFor(client, orgId, { name: "reader" }), call = rest(t, agent.key);
    const won = await call("GET", "/api/v1/records?object=opportunity&filter=stage&value=Won");
    expect(won.json.records.map((r: any) => r.title)).toEqual(["Won deal"]);
    const bad = await call("POST", "/api/v1/suggestions", { action: "update" });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe("VALIDATION");
    expect((await call("GET", "/api/v1/nowhere")).status).toBe(404);
  });
});
