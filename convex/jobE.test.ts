import { describe, expect, it } from "vitest";
import { agentFor, api, objectFields, rest, userAndOrg } from "./test.helpers";
import { RemoldClient } from "../packages/mcp/src/client";

describe("Job E regression boundaries", () => {
  for (const edit of ["changed", "added", "fresh"]) it(`delete proposal ${edit} snapshot is checked`, async () => {
    const { client, orgId, t } = await userAndOrg(), c = await objectFields(client, orgId, "company");
    const r = await client.mutation(api.records.create, { orgId, objectId: c.object._id, values: { [c.fields.name._id]: "Old" } });
    const a = await agentFor(client, orgId, { name: "agent" }), call = rest(t, a.key);
    const s = await call("POST", "/api/v1/suggestions", { action: "delete", record: r.recordId, reason: "remove" });
    if (edit !== "fresh") await client.mutation(api.records.update, { orgId, recordId: r.recordId, values: edit === "changed" ? { [c.fields.name._id]: "New" } : { [c.fields.city._id]: "Boston" } });
    expect((await client.mutation(api.suggestions.apply, { orgId, suggestionId: s.json.suggestion.id })).status).toBe(edit === "fresh" ? "applied" : "conflicted");
    expect(await t.run(ctx => ctx.db.get(r.recordId))).toEqual(edit === "fresh" ? null : expect.objectContaining({ _id: r.recordId }));
  });
  for (const bad of ["number", "required", "lookup"]) it(`rejected CSV row leaves no writes: ${bad}`, async () => {
    const { client, orgId, t } = await userAndOrg(), d = await objectFields(client, orgId, "opportunity");
    const snapshot = () => t.run(async ctx => Promise.all([ctx.db.query("records").collect(), ctx.db.query("links").collect(), ctx.db.query("events").collect(), ctx.db.query("emailRuns").collect()]));
    const before = await snapshot();
    const columns = [d.fields.company._id, d.fields.name._id, bad === "lookup" ? d.fields.person._id : d.fields.amount._id];
    const result = await client.mutation(api.csv.importRows, { orgId, objectId: d.object._id, columns, rows: [["Ghost", bad === "required" ? "" : "Deal", bad === "number" ? "bad" : bad === "lookup" ? "missing-record-code" : "1"]], firstRow: 2, skipDuplicates: false, createMissing: bad !== "lookup" });
    expect(result.created).toBe(0); expect(result.errors).toHaveLength(1); expect(await snapshot()).toEqual(before);
  });
  it("date bounds reject before storage and accepted dates survive REST projection", async () => {
    const { client, orgId, t } = await userAndOrg(), task = await objectFields(client, orgId, "task"), a = await agentFor(client, orgId, { name: "writer", grants: [{ action: "create", objectKey: "task" }] }), call = rest(t, a.key);
    for (const dueDate of [9007199254740991, -9007199254740991, Date.UTC(999, 11, 31), Date.UTC(10000, 0, 1)]) {
      const before = await t.run(ctx => ctx.db.query("records").collect());
      expect((await call("POST", "/api/v1/changes", { action: "create", object: "task", values: { title: "Bad", dueDate }, reason: "test" })).json.error?.code).toBe("VALIDATION");
      expect(await t.run(ctx => ctx.db.query("records").collect())).toEqual(before);
    }
    for (const dueDate of ["1000-01-01", "9999-12-31T23:59:59.999Z", "2026-10-03T00:00:00Z"]) {
      const r = await call("POST", "/api/v1/changes", { action: "create", object: "task", values: { title: "Good", dueDate }, reason: "test" });
      expect(r.status).toBe(200); expect((await call("GET", `/api/v1/records/${r.json.record.id}`)).json.record.values.dueDate).toBe(dueDate.includes("T") ? new Date(dueDate).toISOString() : dueDate);
    }
    await expect(client.mutation(api.records.create, { orgId, objectId: task.object._id, values: { [task.fields.title._id]: "Bad human", [task.fields.dueDate._id]: 9007199254740991 } })).rejects.toThrow();
  });
  for (const restriction of ["none", "hidden", "protected"]) it(`retired ${restriction} values preserve delete authority`, async () => {
    const { client, orgId, t } = await userAndOrg(), c = await objectFields(client, orgId, "company");
    const { fieldId } = await client.mutation(api.fields.create, { orgId, objectId: c.object._id, key: "oldValue", label: "Old", type: "text" });
    const r = await client.mutation(api.records.create, { orgId, objectId: c.object._id, values: { [c.fields.name._id]: "Old", [fieldId]: "retained" } });
    await client.mutation(api.fields.retire, { orgId, fieldId });
    const a = await agentFor(client, orgId, { name: "agent", grants: [{ action: "delete", objectKey: "company" }] });
    if (restriction === "hidden") await t.run(ctx => ctx.db.patch(a.agentId, { hiddenFieldIds: [fieldId] }));
    if (restriction === "protected") await client.mutation(api.fields.update, { orgId, fieldId, protectedFromAgents: true });
    const result = await rest(t, a.key)("POST", "/api/v1/changes", { action: "delete", record: r.recordId, reason: "remove" });
    expect(result.status).toBe(restriction === "none" ? 200 : restriction === "hidden" ? 400 : 403);
    expect(await t.run(ctx => ctx.db.get(r.recordId))).toEqual(restriction === "none" ? null : expect.objectContaining({ _id: r.recordId }));
  });
  it("discovery projects live capabilities and field write modes", async () => {
    const { client, orgId, t } = await userAndOrg(), task = await objectFields(client, orgId, "task"), a = await agentFor(client, orgId, { name: "scoped" });
    const expiresAt = Date.now() + 60000;
    const grantId = await client.mutation(api.authority.grants.grant, { orgId, target: a.agentId, capability: "record.create", scope: { kind: "records", objectId: task.object._id, records: "all", fields: [task.fields.title._id, task.fields.dueDate._id] }, mode: "direct", delegate: false, expiresAt });
    await client.mutation(api.fields.update, { orgId, fieldId: task.fields.done._id, protectedFromAgents: true });
    const call = rest(t, a.key), me = (await call("GET", "/api/v1/me")).json;
    expect(me.agent.capabilities).toContainEqual({ id: grantId, capability: "record.create", scope: { kind: "records", objectId: task.object._id, records: "all", fields: [task.fields.title._id, task.fields.dueDate._id] }, mode: "direct", delegate: false, expiresAt });
    expect(JSON.stringify(me)).not.toMatch(/keyHash|grantorMembershipId/);
    const fields = (await call("GET", "/api/v1/objects")).json.find((o: any) => o.key === "task").fields;
    expect(fields.find((f: any) => f.key === "dueDate")).toMatchObject({ withTime: true, protectedFromAgents: false, write: { create: "direct", update: "propose" } });
    expect(fields.find((f: any) => f.key === "done")).toMatchObject({ protectedFromAgents: true, write: { create: "none", update: "none" } });
    expect((await call("POST", "/api/v1/changes", { action: "create", object: "task", values: { title: "Allowed", dueDate: "2026-10-03" }, reason: "test" })).status).toBe(200);
    await client.mutation(api.authority.grants.revoke, { orgId, id: grantId });
    expect((await call("GET", "/api/v1/me")).json.agent.capabilities).toEqual([]);
  });
  it("MCP retry after response loss returns the original REST write and pages events", async () => {
    const { client, orgId, t } = await userAndOrg(), a = await agentFor(client, orgId, { name: "writer", grants: [{ action: "create", objectKey: "company" }] });
    let lost = true, original: any;
    const mcp = new RemoldClient({ url: "http://local", key: a.key, fetch: async (input, init) => { const r = new Request(input, init), response = await t.fetch(new URL(r.url).pathname + new URL(r.url).search, init); if (lost) { lost = false; original = await response.json(); throw new Error("response lost"); } return response; } });
    const args = { action: "create", object: "company", values: { name: "Once" }, reason: "retry", idempotencyKey: "stable" };
    await expect(mcp.change(args)).rejects.toThrow("response lost"); expect(await mcp.change(args)).toEqual(original);
    expect(await t.run(ctx => ctx.db.query("records").collect())).toHaveLength(1); expect(await t.run(ctx => ctx.db.query("events").collect())).toHaveLength(1);
    const company = await objectFields(client, orgId, "company");
    await client.mutation(api.records.update, { orgId, recordId: original.record.id, values: { [company.fields.city._id]: "Boston" } });
    const page: any = await mcp.recordEvents({ idOrRef: original.record.id, limit: 1 }); expect(page.events).toHaveLength(1);
    const next: any = await mcp.recordEvents({ idOrRef: original.record.id, limit: 1, cursor: page.nextCursor }); expect(next.events).toHaveLength(1); expect(next.events[0].action).toBe("create");
  });
  it("REST Today uses the app selection for retained done values", async () => {
    const { client, orgId, t } = await userAndOrg(), task = await objectFields(client, orgId, "task"), a = await agentFor(client, orgId, { name: "agent" });
    await client.mutation(api.records.create, { orgId, objectId: task.object._id, values: { [task.fields.title._id]: "Finished", [task.fields.dueDate._id]: Date.now() - 86400000, [task.fields.done._id]: true } });
    await client.mutation(api.fields.retire, { orgId, fieldId: task.fields.done._id });
    const today = Math.floor(Date.now() / 86400000) * 86400000, app = await client.query(api.today.get, { orgId, today });
    const result = (await rest(t, a.key)("GET", "/api/v1/today")).json;
    expect(result.tasks.map((r: any) => r.id)).toEqual(app.tasks.map(r => r._id)); expect(result.tasks).toEqual([]);
  });
});

it("REST write keys deduplicate proposals and inbox writes", async () => {
  const { client, orgId, t } = await userAndOrg(), a = await agentFor(client, orgId, { name: "agent", role: "admin" });
  const mcp = new RemoldClient({ url: "http://local", key: a.key, fetch: (input, init) => t.fetch(new URL(String(input)).pathname, init) });
  for (const [write, args, table] of [
    [mcp.propose.bind(mcp), { action: "create", object: "company", values: { name: "Once" }, reason: "test", idempotencyKey: "proposal" }, "suggestions"],
    [mcp.inboxAdd.bind(mcp), { text: "Once", idempotencyKey: "inbox" }, "agentInbox"],
    [mcp.proposeShape.bind(mcp), { kind: "addField", object: "company", key: "extra", label: "Extra", type: "text", reason: "test", idempotencyKey: "shape" }, "shapeSuggestions"],
  ] as const) {
    const first = await write(args); expect(await write(args)).toEqual(first);
    expect(await t.run(ctx => ctx.db.query(table).collect())).toHaveLength(1);
  }
  const inbox: any = await mcp.inbox(); const args = { id: inbox[0].id, note: "Done", idempotencyKey: "resolve" };
  expect(await mcp.inboxResolve(args)).toEqual(await mcp.inboxResolve(args));
});
it("stale delete conflicts do not reveal newly hidden values", async () => {
  const { client, orgId, t } = await userAndOrg(), c = await objectFields(client, orgId, "company"), a = await agentFor(client, orgId, { name: "agent" });
  const r = await client.mutation(api.records.create, { orgId, objectId: c.object._id, values: { [c.fields.name._id]: "Old" } });
  const s = await rest(t, a.key)("POST", "/api/v1/suggestions", { action: "delete", record: r.recordId, reason: "remove" });
  await client.mutation(api.records.update, { orgId, recordId: r.recordId, values: { [c.fields.city._id]: "SECRET CITY" } });
  await t.run(async ctx => { const member = (await ctx.db.query("members").collect())[0]; await ctx.db.patch(member._id, { hiddenFieldIds: [c.fields.city._id] }); });
  const result = await client.mutation(api.suggestions.apply, { orgId, suggestionId: s.json.suggestion.id });
  expect(result.status).toBe("conflicted"); expect(JSON.stringify(result)).not.toContain("SECRET CITY");
});
it("discovery describes direct update fields limited to named records", async () => {
  const { client, orgId, t } = await userAndOrg(), c = await objectFields(client, orgId, "company"), a = await agentFor(client, orgId, { name: "agent" });
  const r = await client.mutation(api.records.create, { orgId, objectId: c.object._id, values: { [c.fields.name._id]: "Scoped" } });
  await client.mutation(api.authority.grants.grant, { orgId, target: a.agentId, capability: "record.update", scope: { kind: "records", objectId: c.object._id, records: [r.recordId], fields: [c.fields.city._id] }, mode: "direct", delegate: false, expiresAt: Date.now() + 60000 });
  const call = rest(t, a.key), fields = (await call("GET", "/api/v1/objects")).json.find((o: any) => o.key === "company").fields;
  expect(fields.find((f: any) => f.key === "city").write.update).toBe("direct");
  expect((await call("POST", "/api/v1/changes", { action: "update", record: r.recordId, values: { city: "Boston" }, reason: "test" })).status).toBe(200);
});
