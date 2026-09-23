import { describe, expect, it } from "vitest";
import { agentFor, api, objectFields, rest, userAndOrg } from "./test.helpers";

describe("suggestions", () => {
  it("applies once with agent attribution and conflicts after a person edit", async () => {
    const { client, orgId, t } = await userAndOrg();
    const opportunity = await objectFields(client, orgId, "opportunity");
    const created = await client.mutation(api.records.create, { orgId, objectId: opportunity.object._id, values: { [opportunity.fields.name._id]: "Deal", [opportunity.fields.stage._id]: "new" } });
    const detail = await client.query(api.records.get, { orgId, recordId: created.recordId });
    const agent = await agentFor(client, orgId, { name: "Claude" });
    const response = await rest(t, agent.key)("POST", "/api/v1/suggestions", { action: "update", record: detail!.record.ref, values: { stage: "Won" }, reason: "ready" });
    const applied = await client.mutation(api.suggestions.apply, { orgId, suggestionId: response.json.suggestion.id });
    expect(applied.status).toBe("applied");
    expect((await client.query(api.events.forRecord, { orgId, recordId: created.recordId }))[0]).toMatchObject({ actor: { kind: "agent", id: agent.agentId }, suggestionId: response.json.suggestion.id, actorName: "Claude", appliedByName: "A" });
    expect(await client.mutation(api.suggestions.apply, { orgId, suggestionId: response.json.suggestion.id })).toMatchObject({ status: "already" });
    const second = await rest(t, agent.key)("POST", "/api/v1/suggestions", { action: "update", record: detail!.record.ref, values: { stage: "New" }, reason: "retry" });
    await client.mutation(api.records.update, { orgId, recordId: created.recordId, values: { [opportunity.fields.stage._id]: "lost" } });
    const conflict = await client.mutation(api.suggestions.apply, { orgId, suggestionId: second.json.suggestion.id });
    expect(conflict).toMatchObject({ status: "conflicted", conflicts: [{ expected: "won", actual: "lost" }] });
    expect(await client.mutation(api.suggestions.dismiss, { orgId, suggestionId: second.json.suggestion.id })).toMatchObject({ status: "dismissed" });
  });
  it("creates one record when a create suggestion is applied twice", async () => {
    const { client, orgId, t } = await userAndOrg();
    const agent = await agentFor(client, orgId, { name: "Claude" });
    const response = await rest(t, agent.key)("POST", "/api/v1/suggestions", { action: "create", object: "company", values: { name: "Once" }, reason: "new" });
    const first = await client.mutation(api.suggestions.apply, { orgId, suggestionId: response.json.suggestion.id });
    const second = await client.mutation(api.suggestions.apply, { orgId, suggestionId: response.json.suggestion.id });
    expect(first.status).toBe("applied");
    expect(second).toMatchObject({ status: "already" });
    expect((await client.query(api.records.list, { orgId, objectId: (await objectFields(client, orgId, "company")).object._id, paginationOpts: { cursor: null, numItems: 100 } })).page.filter((record: any) => record.title === "Once")).toHaveLength(1);
  });
});
