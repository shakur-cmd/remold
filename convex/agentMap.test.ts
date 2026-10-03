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

// Rows go straight into the table: only how many exist matters here.
async function venue2(t: any, client: any, orgId: any, key: string, rows: number) {
  const objectId = await client.mutation(api.objects.create, { orgId, key, label: key, labelPlural: key });
  const user = await client.query(api.users.me, {});
  await t.run(async (ctx: any) => { for (let i = 0; i < rows; i++) await ctx.db.insert("records", { orgId, objectId, values: {}, title: `r${i}`, createdBy: user._id, updatedAt: 0 }); });
  return objectId;
}

const readAll = (client: any, orgId: any, agentId: any) => client.mutation(api.agents.setReadAccess, { orgId, agentId, readAllObjects: true, objectIds: [] });

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
    expect(company.count).toBe("1-50");
    expect(map.objects.find((o: any) => o.key === "person").fields.every((f: any) => f.write.create === "propose")).toBe(true);
    expect(company.fields.find((f: any) => f.key !== "name").write.update).toBe("direct");
    expect(map.agent.name).toBe("scoped");
    expect(map.pending).toEqual({ inbox: expect.any(Number), suggestions: 0, shapeProposals: 0 });
    expect(map.canDo.join(" ")).toMatch(/apply/i);
    expect(map.canDo.join(" ")).toMatch(/propose/i);
  });

  it("reports coarse counts: 0, 1-50 or 50+", async () => {
    const { t, client, orgId } = await userAndOrg();
    const agent = await agentFor(client, orgId, { name: "reader" }), call = rest(t, agent.key);
    await readAll(client, orgId, agent.agentId);
    await venue(client, orgId);
    await venue2(t, client, orgId, "few", 3);
    await venue2(t, client, orgId, "many", 60);
    const counts = Object.fromEntries((await call("GET", "/api/v1/map")).json.objects.map((o: any) => [o.key, o.count]));
    expect(counts).toMatchObject({ venue: "0", few: "1-50", many: "50+" });
  });

  it("counts a record-scoped agent's own records, however many it cannot read", async () => {
    const { t, client, orgId } = await userAndOrg();
    const agent = await agentFor(client, orgId, { name: "scoped" }), call = rest(t, agent.key);
    const v = await venue(client, orgId);
    await t.run(async (ctx: any) => { for (let i = 0; i < 1001; i++) await ctx.db.insert("records", { orgId, objectId: v.objectId, values: {}, title: "x", createdBy: agent.agentId, updatedAt: 0 }); });
    const mine = await client.mutation(api.records.create, { orgId, objectId: v.objectId, values: { [v.fields.name._id]: "Mine" } });
    const first = { _id: mine.recordId };
    await client.mutation(api.authority.grants.grant, { orgId, target: agent.agentId, capability: "read", scope: { kind: "records", objectId: v.objectId, records: [first._id], fields: [v.fields.name._id] }, mode: "direct", delegate: false, expiresAt: Date.now() + 60000 });
    expect((await call("GET", "/api/v1/records?object=venue")).json.records).toHaveLength(1);
    expect((await call("GET", "/api/v1/map")).json.objects.find((o: any) => o.key === "venue").count).toBe("1-50");
  });

  it("stays within a fixed read budget across many large objects, and says unknown past it", async () => {
    const { t, client, orgId } = await userAndOrg();
    const agent = await agentFor(client, orgId, { name: "wide" }), call = rest(t, agent.key);
    await readAll(client, orgId, agent.agentId);
    for (let n = 0; n < 15; n++) await venue2(t, client, orgId, `big${String(n).padStart(2, "0")}`, 2000);
    const counts = (await call("GET", "/api/v1/map")).json.objects.filter((o: any) => o.key.startsWith("big")).map((o: any) => o.count);
    // 51 reads each against a 600 read budget: 11 objects are answered, the rest are unknown.
    expect(counts).toEqual([...Array(11).fill("50+"), ...Array(4).fill("unknown")]);
  }, 120000);

  it("leaves archived objects out, with their counts", async () => {
    const { t, client, orgId } = await userAndOrg();
    const agent = await agentFor(client, orgId, { name: "a", grants: [{ action: "delete", objectKey: "*" }] }), call = rest(t, agent.key);
    await readAll(client, orgId, agent.agentId);
    const v = await venue(client, orgId, 2);
    expect((await call("GET", "/api/v1/map")).json.objects.map((o: any) => o.key)).toContain("venue");
    await t.run((ctx: any) => ctx.db.patch(v.objectId, { archived: true }));
    const map = (await call("GET", "/api/v1/map")).json;
    expect(map.objects.map((o: any) => o.key)).not.toContain("venue");
    expect(map.canDo.join(" ")).not.toContain("Venue");
  }, 30000);

  it("lists a feature only when its object is readable", async () => {
    const { t, client, orgId } = await userAndOrg();
    const agent = await agentFor(client, orgId, { name: "f" }), call = rest(t, agent.key);
    const listed = (await client.query(api.agents.list, { orgId })).find((a: any) => a._id === agent.agentId)!;
    const email = (await client.query(api.objects.list, { orgId })).find((o: any) => o.key === "email");
    await client.mutation(api.agents.setReadAccess, { orgId, agentId: agent.agentId, readAllObjects: false, objectIds: listed.readObjectIds!.filter((id: any) => id !== email!._id) });
    const map = (await call("GET", "/api/v1/map")).json;
    expect(map.objects.map((o: any) => o.key)).not.toContain("email");
    expect(map.features).not.toContain("emails");
    expect(map.features).toContain("campaigns");
  });

  it("says it can delete only where a delete grant covers it, including grants on single records", async () => {
    const { t, client, orgId } = await userAndOrg();
    const company = await objectFields(client, orgId, "company");
    const none = await agentFor(client, orgId, { name: "none", grants: [{ action: "update", objectKey: "company" }] });
    const wide = await agentFor(client, orgId, { name: "wide", grants: [{ action: "delete", objectKey: "company" }] });
    const one = await agentFor(client, orgId, { name: "one" });
    const record = await client.mutation(api.records.create, { orgId, objectId: company.object._id, values: { [company.fields.name._id]: "Acme" } });
    await client.mutation(api.authority.grants.grant, { orgId, target: one.agentId, capability: "record.delete", scope: { kind: "records", objectId: company.object._id, records: [record.recordId], fields: [company.fields.name._id] }, mode: "direct", delegate: false, expiresAt: Date.now() + 60000 });
    const said = async (key: string) => (await rest(t, key)("GET", "/api/v1/map")).json.canDo.join(" ");
    expect(await said(none.key)).not.toContain("delete");
    expect(await said(wide.key)).toContain("Company (delete)");
    expect(await said(one.key)).toContain("Company (delete)");
  });

  it("lists the standard features that exist and the agent can read", async () => {
    const { t, client, orgId } = await userAndOrg();
    const agent = await agentFor(client, orgId, { name: "f" }), call = rest(t, agent.key);
    const map = (await call("GET", "/api/v1/map")).json;
    expect(map.features).toEqual(expect.arrayContaining(["campaigns", "emails", "posts", "invoices"]));
    // Booking pages exist once campaigns/booking is merged; a key that cannot read them does not see the feature.
    expect(map.features).toContain("bookingPages");
    const objects = await client.query(api.objects.list, { orgId }), narrow = await agentFor(client, orgId, { name: "narrow" });
    await t.run((ctx: any) => ctx.db.patch(narrow.agentId, { readObjectIds: objects.filter((o: any) => o.key !== "bookingPage").map((o: any) => o._id) }));
    expect((await rest(t, narrow.key)("GET", "/api/v1/map")).json.features).not.toContain("bookingPages");
  });

  it("is refused without a key", async () => {
    const { t } = await userAndOrg();
    expect((await rest(t, "rm_nope")("GET", "/api/v1/map")).status).toBe(401);
  });
});
