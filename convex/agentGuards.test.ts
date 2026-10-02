import { expect, it } from "vitest";
import { agentFor, api, objectFields, rest, userAndOrg } from "./test.helpers";

async function world() {
  const f = await userAndOrg();
  const opp = await objectFields(f.client, f.orgId, "opportunity");
  const deal = async (stage: string): Promise<any> => (await f.client.mutation(api.records.create, { orgId: f.orgId, objectId: opp.object._id, values: { [opp.fields.name._id]: `Deal ${stage}`, [opp.fields.stage._id]: stage } })).recordId;
  const agent = await agentFor(f.client, f.orgId, { name: "closer", grants: [{ action: "create", objectKey: "opportunity" }, { action: "update", objectKey: "opportunity" }, { action: "delete", objectKey: "opportunity" }] });
  const call = rest(f.t, agent.key);
  const stageOf = async (id: any) => ((await f.t.run((ctx: any) => ctx.db.get(id))) as any).values[opp.fields.stage._id];
  // A proposal stored as an older release would have stored it, before propose-time checks existed.
  const stored = (recordId: any, values: Record<string, unknown>) => f.t.run(async (ctx: any) => {
    const record = await ctx.db.get(recordId);
    return ctx.db.insert("suggestions", { orgId: f.orgId, agentId: agent.agentId, authorityEpoch: 0, status: "pending", change: { action: "update", objectId: opp.object._id, recordId, values }, recordId, before: Object.fromEntries(Object.keys(values).map((id) => [id, record.values[id] ?? null])), reason: "older proposal" });
  });
  return { ...f, opp, deal, agent, call, stageOf, stored };
}

it("an agent moves an opportunity stage forward but not backward", async () => {
  const w = await world(), id = await w.deal("qualified");
  const back = await w.call("POST", "/api/v1/changes", { action: "update", record: id, values: { stage: "contacted" }, reason: "regress" });
  expect(back.status).toBe(403);
  expect(back.json.error.message).toMatch(/forward/i);
  expect(await w.stageOf(id)).toBe("qualified");
  expect((await w.call("POST", "/api/v1/changes", { action: "update", record: id, values: { stage: null }, reason: "clear" })).status).toBe(403);
  expect((await w.call("POST", "/api/v1/changes", { action: "update", record: id, values: { stage: "proposal" }, reason: "advance" })).status).toBe(200);
  expect(await w.stageOf(id)).toBe("proposal");
  expect((await w.call("POST", "/api/v1/suggestions", { action: "update", record: id, values: { stage: "new" }, reason: "regress" })).status).toBe(403);
});

it("an agent cannot change or delete a won or lost opportunity", async () => {
  const w = await world();
  for (const stage of ["won", "lost"]) {
    const id = await w.deal(stage);
    const moved = await w.call("POST", "/api/v1/changes", { action: "update", record: id, values: { stage: stage === "won" ? "lost" : "won" }, reason: "flip" });
    expect(moved.status).toBe(403);
    expect(moved.json.error.message).toMatch(/won or lost/i);
    expect((await w.call("POST", "/api/v1/changes", { action: "delete", record: id, reason: "remove" })).status).toBe(403);
    expect(await w.stageOf(id)).toBe(stage);
  }
});

it("a stored backward stage proposal is refused when a person applies it, and a person may move stages back", async () => {
  const w = await world(), id = await w.deal("proposal");
  const suggestionId = await w.stored(id, { [w.opp.fields.stage._id]: "new" });
  await expect(w.client.mutation(api.suggestions.apply, { orgId: w.orgId, suggestionId })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
  expect(await w.stageOf(id)).toBe("proposal");
  await w.client.mutation(api.records.update, { orgId: w.orgId, recordId: id, values: { [w.opp.fields.stage._id]: "new" } });
  expect(await w.stageOf(id)).toBe("new");
});

it("a field protected from agents refuses agent writes and proposals but not people", async () => {
  const w = await world(), id = await w.deal("new"), amount = w.opp.fields.amount._id;
  expect((await w.call("POST", "/api/v1/changes", { action: "update", record: id, values: { amount: 10 }, reason: "before protection" })).status).toBe(200);
  await w.client.mutation(api.fields.update, { orgId: w.orgId, fieldId: amount, protectedFromAgents: true });
  expect((await w.client.query(api.fields.list, { orgId: w.orgId, objectId: w.opp.object._id })).find((f: any) => f._id === amount)?.protectedFromAgents).toBe(true);
  const write = await w.call("POST", "/api/v1/changes", { action: "update", record: id, values: { amount: 99 }, reason: "raise" });
  expect(write.status).toBe(403);
  expect(write.json.error.message).toMatch(/protected/i);
  expect((await w.call("POST", "/api/v1/changes", { action: "create", object: "opportunity", values: { name: "New deal", amount: 5 }, reason: "create" })).status).toBe(403);
  expect((await w.call("POST", "/api/v1/suggestions", { action: "update", record: id, values: { amount: 99 }, reason: "raise" })).status).toBe(403);
  expect((await w.call("POST", "/api/v1/changes", { action: "delete", record: id, reason: "remove" })).status).toBe(403);
  const suggestionId = await w.stored(id, { [amount]: 98 });
  await expect(w.client.mutation(api.suggestions.apply, { orgId: w.orgId, suggestionId })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
  // Other fields stay writable, and people still edit the protected one.
  expect((await w.call("POST", "/api/v1/changes", { action: "update", record: id, values: { stage: "contacted" }, reason: "advance" })).status).toBe(200);
  await w.client.mutation(api.records.update, { orgId: w.orgId, recordId: id, values: { [amount]: 50 } });
  expect(((await w.t.run((ctx: any) => ctx.db.get(id))) as any).values[amount]).toBe(50);
  await w.client.mutation(api.fields.update, { orgId: w.orgId, fieldId: amount, protectedFromAgents: false });
  expect((await w.call("POST", "/api/v1/changes", { action: "update", record: id, values: { amount: 60 }, reason: "unprotected" })).status).toBe(200);
});

it("only an admin can protect a field", async () => {
  const w = await world(), amount = w.opp.fields.amount._id;
  const token = (await w.client.mutation(api.invites.create, { orgId: w.orgId, role: "member" })).token;
  const member = w.t.withIdentity({ tokenIdentifier: "clerk|M", name: "M" });
  await member.mutation(api.users.store, {}); await member.mutation(api.invites.accept, { token });
  await expect(member.mutation(api.fields.update, { orgId: w.orgId, fieldId: amount, protectedFromAgents: true })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
});
