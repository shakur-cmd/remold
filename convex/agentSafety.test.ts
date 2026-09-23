import { describe, expect, it } from "vitest";
import { agentFor, api, objectFields, rest, userAndOrg } from "./test.helpers";

// Two orgs in ONE database, so a leak would actually show up.
async function twoOrgs() {
  const a = await userAndOrg("A");
  const bClient = a.t.withIdentity({ tokenIdentifier: "clerk|B", name: "B" });
  await bClient.mutation(api.users.store, {});
  const bOrgId = await bClient.mutation(api.orgs.create, { name: "B Org" });
  return { t: a.t, a: { client: a.client, orgId: a.orgId }, b: { client: bClient, orgId: bOrgId } };
}
const sha256 = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");
async function snapshot(t: any) {
  return t.run(async (ctx: any) => JSON.stringify(await Promise.all(["records", "events", "suggestions", "agentInbox", "links"].map((table) => ctx.db.query(table).collect()))));
}

describe("agent safety", () => {
  it("keeps a key inside its own org even when a body names another agent's hash", async () => {
    const { t, a, b } = await twoOrgs();
    const bCompany = await objectFields(b.client, b.orgId, "company");
    await b.client.mutation(api.records.create, { orgId: b.orgId, objectId: bCompany.object._id, values: { [bCompany.fields.name._id]: "B Secret Co" } });
    const agentA = await agentFor(a.client, a.orgId, { name: "a" }), agentB = await agentFor(b.client, b.orgId, { name: "b" });
    const callA = rest(t, agentA.key);
    expect((await callA("GET", "/api/v1/records?object=company")).json.records).toEqual([]);
    expect((await callA("GET", "/api/v1/search?q=Secret")).json).toEqual([]);
    const forged = await callA("POST", "/api/v1/inbox", { text: "smuggled", keyHash: await sha256(agentB.key) });
    expect(forged.status).toBe(201);
    expect((await a.client.query(api.inbox.list, { orgId: a.orgId, status: "pending" })).map((i) => i.text)).toEqual(["smuggled"]);
    expect(await b.client.query(api.inbox.list, { orgId: b.orgId, status: "pending" })).toEqual([]);
    const unknownHeader = await t.fetch("/api/v1/inbox", { method: "POST", headers: { authorization: `Bearer rm_${"1".repeat(40)}`, "content-type": "application/json" }, body: JSON.stringify({ text: "x", keyHash: await sha256(agentB.key) }) });
    expect(unknownHeader.status).toBe(401);
  });

  it("writes nothing on a refused change, a conflict, or a second apply", async () => {
    const { t, client, orgId } = await userAndOrg();
    const opp = await objectFields(client, orgId, "opportunity");
    const deal = await client.mutation(api.records.create, { orgId, objectId: opp.object._id, values: { [opp.fields.name._id]: "Deal", [opp.fields.stage._id]: "new" } });
    const agent = await agentFor(client, orgId, { name: "agent" }), call = rest(t, agent.key);
    const before = await snapshot(t);
    expect((await call("POST", "/api/v1/changes", { action: "update", record: deal.recordId, values: { stage: "won" }, reason: "no grant" })).status).toBe(403);
    expect(await snapshot(t)).toBe(before);
    const proposal = await call("POST", "/api/v1/suggestions", { action: "update", record: deal.recordId, values: { stage: "won" }, reason: "ready" });
    await client.mutation(api.records.update, { orgId, recordId: deal.recordId, values: { [opp.fields.stage._id]: "lost" } });
    const edited = await snapshot(t);
    const events = (await client.query(api.events.forRecord, { orgId, recordId: deal.recordId })).length;
    expect((await client.mutation(api.suggestions.apply, { orgId, suggestionId: proposal.json.suggestion.id })).status).toBe("conflicted");
    expect((await client.query(api.records.get, { orgId, recordId: deal.recordId }))!.record.values[opp.fields.stage._id]).toBe("lost");
    expect((await client.query(api.events.forRecord, { orgId, recordId: deal.recordId })).length).toBe(events);
    expect(JSON.parse(await snapshot(t))[0]).toEqual(JSON.parse(edited)[0]);
    const fresh = await call("POST", "/api/v1/suggestions", { action: "update", record: deal.recordId, values: { stage: "qualified" }, reason: "again" });
    await client.mutation(api.suggestions.apply, { orgId, suggestionId: fresh.json.suggestion.id });
    const applied = await snapshot(t);
    expect((await client.mutation(api.suggestions.apply, { orgId, suggestionId: fresh.json.suggestion.id })).status).toBe("already");
    expect(await snapshot(t)).toBe(applied);
    expect((await client.query(api.events.forRecord, { orgId, recordId: deal.recordId })).length).toBe(events + 1);
  });

  it("refuses a proposal a person could not apply, and an impossible date", async () => {
    const { t, client, orgId } = await userAndOrg();
    const agent = await agentFor(client, orgId, { name: "agent" }), call = rest(t, agent.key);
    const noName = await call("POST", "/api/v1/suggestions", { action: "create", object: "company", values: { city: "Boston" }, reason: "new" });
    expect(noName.status).toBe(400);
    expect(noName.json.error.fieldKey).toBe("name");
    expect(await client.query(api.suggestions.list, { orgId, status: "pending" })).toEqual([]);
    const badDate = await call("POST", "/api/v1/suggestions", { action: "create", object: "task", values: { title: "Call", dueDate: "2026-02-31" }, reason: "typo" });
    expect(badDate.status).toBe(400);
    expect(badDate.json.error.fieldKey).toBe("dueDate");
  });

  it("shows a clear as null and dates as text in a suggestion", async () => {
    const { t, client, orgId } = await userAndOrg();
    const task = await objectFields(client, orgId, "task");
    const item = await client.mutation(api.records.create, { orgId, objectId: task.object._id, values: { [task.fields.title._id]: "Call", [task.fields.dueDate._id]: Date.UTC(2026, 9, 1) } });
    const agent = await agentFor(client, orgId, { name: "agent" }), call = rest(t, agent.key);
    const proposal = await call("POST", "/api/v1/suggestions", { action: "update", record: item.recordId, values: { dueDate: null }, reason: "no deadline" });
    expect(proposal.json.suggestion.values).toEqual({ dueDate: null });
    expect(proposal.json.suggestion.before).toEqual({ dueDate: "2026-10-01" });
  });

  it("resolves the inbox item when its suggestion is applied", async () => {
    const { t, client, orgId } = await userAndOrg();
    const agent = await agentFor(client, orgId, { name: "agent" }), call = rest(t, agent.key);
    const inboxId = await client.mutation(api.inbox.add, { orgId, text: "Add Atlas as a company" });
    const proposal = await call("POST", "/api/v1/suggestions", { action: "create", object: "company", values: { name: "Atlas" }, reason: "from inbox", inboxId });
    expect((await call("GET", "/api/v1/inbox")).json).toHaveLength(1);
    await client.mutation(api.suggestions.apply, { orgId, suggestionId: proposal.json.suggestion.id });
    expect((await call("GET", "/api/v1/inbox")).json).toEqual([]);
    expect((await call("GET", "/api/v1/inbox?status=resolved")).json[0]).toMatchObject({ suggestionId: proposal.json.suggestion.id });
  });

  it("drops a deleted task from the blockedBy of the tasks it blocked", async () => {
    const { client, orgId } = await userAndOrg();
    const task = await objectFields(client, orgId, "task");
    const blocker = await client.mutation(api.records.create, { orgId, objectId: task.object._id, values: { [task.fields.title._id]: "Blocker" } });
    const blocked = await client.mutation(api.records.create, { orgId, objectId: task.object._id, values: { [task.fields.title._id]: "Blocked", [task.fields.blockedBy._id]: [blocker.recordId] } });
    await client.mutation(api.records.remove, { orgId, recordId: blocker.recordId });
    const after = await client.query(api.records.get, { orgId, recordId: blocked.recordId });
    expect(after!.record.values[task.fields.blockedBy._id] ?? []).toEqual([]);
    const events = await client.query(api.events.forRecord, { orgId, recordId: blocked.recordId });
    expect(events[0]).toMatchObject({ action: "update", reason: "Linked Blocker was deleted" });
  });
});
