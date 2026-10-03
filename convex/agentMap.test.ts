import { describe, expect, it } from "vitest";
import { agentFor, api, objectFields, rest, userAndOrg } from "./test.helpers";

// One call tells an agent what the workspace is, so it does not need five calls to find out.
async function venue(client: any, orgId: any, rows = 0) {
  const objectId = await client.mutation(api.objects.create, { orgId, key: "venue", label: "Venue", labelPlural: "Venues" });
  await client.mutation(api.fields.create, { orgId, objectId, key: "capacity", label: "Capacity", type: "number" });
  const { fields } = await objectFields(client, orgId, "venue");
  for (let i = 0; i < rows; i++) await client.mutation(api.records.create, { orgId, objectId, values: { [fields.name._id]: `Hall ${i}`, [fields.capacity._id]: i } });
  return { objectId, fields };
}

describe("GET /api/v1/map", () => {
  it("shows only readable objects and fields, with write modes and counts, to a scoped agent", async () => {
    const { t, client, orgId } = await userAndOrg();
    const agent = await agentFor(client, orgId, { name: "scoped", grants: [{ action: "update", objectKey: "company" }] }), call = rest(t, agent.key);
    await client.mutation(api.records.create, { orgId, objectId: (await objectFields(client, orgId, "company")).object._id, values: { [(await objectFields(client, orgId, "company")).fields.name._id]: "Atlas" } });
    await venue(client, orgId, 2);
    const hidden = (await objectFields(client, orgId, "company")).fields.name._id;
    await client.mutation(api.authority.policies.setAgentMasks, { orgId, agentId: agent.agentId, hiddenFieldIds: [hidden] });
    const map = (await call("GET", "/api/v1/map")).json;
    const keys = map.objects.map((o: any) => o.key);
    expect(keys).toContain("company");
    expect(keys).not.toContain("venue");
    const company = map.objects.find((o: any) => o.key === "company");
    expect(company.fields.map((f: any) => f.key)).not.toContain("name");
    expect(JSON.stringify(map)).not.toContain("Atlas");
    expect(company.count).toBe(1);
    expect(map.objects.find((o: any) => o.key === "person").fields.every((f: any) => f.write.create === "propose")).toBe(true);
    expect(company.fields.find((f: any) => f.key !== "name").write.update).toBe("direct");
    expect(map.agent.name).toBe("scoped");
    expect(map.pending).toEqual({ inbox: expect.any(Number), suggestions: 0, shapeProposals: 0 });
    expect(map.canDo.join(" ")).toMatch(/apply/i);
    expect(map.canDo.join(" ")).toMatch(/propose/i);
  });

  it("reports counts only for readable objects and caps them at 1000", async () => {
    const { t, client, orgId } = await userAndOrg();
    const agent = await agentFor(client, orgId, { name: "reader" }), call = rest(t, agent.key);
    const v = await venue(client, orgId);
    await t.run(async (ctx: any) => { for (let i = 0; i < 1005; i++) await ctx.db.insert("records", { orgId, objectId: v.objectId, values: {}, title: "x", createdBy: agent.agentId, updatedAt: 0 }); });
    expect((await call("GET", "/api/v1/map")).json.objects.map((o: any) => o.key)).not.toContain("venue");
    const all = (await client.query(api.agents.list, { orgId })).find((a: any) => a._id === agent.agentId);
    await client.mutation(api.agents.setReadAccess, { orgId, agentId: agent.agentId, readAllObjects: true, objectIds: all?.readObjectIds ?? [] });
    const row = (await call("GET", "/api/v1/map")).json.objects.find((o: any) => o.key === "venue");
    expect(row.count).toBe(1000);
    expect(row.countCapped).toBe(true);
  });

  it("lists the standard features that exist and the agent can read", async () => {
    const { t, client, orgId } = await userAndOrg();
    const agent = await agentFor(client, orgId, { name: "f" }), call = rest(t, agent.key);
    const map = (await call("GET", "/api/v1/map")).json;
    expect(map.features).toEqual(expect.arrayContaining(["campaigns", "emails", "posts", "invoices"]));
    expect(map.features).not.toContain("bookingPages");
  });

  it("is refused without a key", async () => {
    const { t } = await userAndOrg();
    expect((await rest(t, "rm_nope")("GET", "/api/v1/map")).status).toBe(401);
  });
});
