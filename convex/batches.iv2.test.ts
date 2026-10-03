// Independent verification round 2 (Sol 6.1, REVISE on 8ebb40b): its repros, adopted in round 4. The history repro
// now reads every history path (forRecord, timeline, forOrg, REST record and record events, MCP over both transports).
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { agentFor, api, mcpTool, objectFields, rest, userAndOrg } from "./test.helpers";
import { internal } from "./_generated/api";

const run = (t: any) => t.finishAllScheduledFunctions(vi.runAllTimers);
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
afterEach(() => { vi.useRealTimers(); });

async function workspace() {
  const w = await userAndOrg();
  const opp = await objectFields(w.client, w.orgId, "opportunity"), person = await objectFields(w.client, w.orgId, "person"), company = await objectFields(w.client, w.orgId, "company");
  const create = async (o: any, values: Record<string, unknown>) => (await w.client.mutation(api.records.create, { orgId: w.orgId, objectId: o.object._id, values: Object.fromEntries(Object.entries(values).map(([k, v]) => [o.fields[k]._id, v])) })).recordId;
  const get = async (id: any): Promise<any> => (await w.client.query(api.records.get, { orgId: w.orgId, recordId: id }))?.record;
  return { ...w, opp, person, company, create, get };
}
const hostedTool = (t: any, key: string) => async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
  const response = await t.fetch("/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  const { result } = await response.json();
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text);
};

it("applied multi-object batch reason stays masked on record history", async () => {
  const w = await workspace(), agent = await agentFor(w.client, w.orgId, { name: "Verifier" });
  const p = await w.create(w.person, { name: "P" }), o = await w.create(w.opp, { name: "O", amount: 987654321 });
  const s = await rest(w.t, agent.key)("POST", "/api/v1/batches", { reason: "secret amount 987654321", changes: [{ action: "update", record: p, values: { title: "T" } }, { action: "update", record: o, values: { stage: "qualified" } }] });
  await w.client.mutation(api.batches.apply, { orgId: w.orgId, batchId: s.json.batch.id }); await run(w.t);
  const invite = await w.client.mutation(api.invites.create, { orgId: w.orgId, role: "member" });
  const m = w.t.withIdentity({ tokenIdentifier: "clerk|ivH2", name: "M" }); await m.mutation(api.users.store, {}); await m.mutation(api.invites.accept, { token: invite.token });
  await w.t.run(async (ctx: any) => { const member = (await ctx.db.query("members").collect()).find((x: any) => x.role === "member"); await ctx.db.patch(member._id, { hiddenFieldIds: [w.opp.fields.amount._id] }); });
  expect((await m.query(api.batches.list, { orgId: w.orgId, status: "done" }))[0].reason).toBe("");
  const page = { cursor: null, numItems: 50 };
  const human = [await m.query(api.events.forRecord, { orgId: w.orgId, recordId: p }), await m.query(api.events.timeline, { orgId: w.orgId, recordId: p, paginationOpts: page }), await m.query(api.events.forOrg, { orgId: w.orgId, paginationOpts: page })];
  const reader = await agentFor(w.client, w.orgId, { name: "Reader" });
  await w.t.run((ctx: any) => ctx.db.patch(reader.agentId, { hiddenFieldIds: [w.opp.fields.amount._id] }));
  const agentViews = [(await rest(w.t, reader.key)("GET", `/api/v1/records/${p}`)).json, (await rest(w.t, reader.key)("GET", `/api/v1/records/${p}/events`)).json, await mcpTool(w.t, reader.key)("remold_record_events", { idOrRef: p }), await hostedTool(w.t, reader.key)("remold_record_events", { idOrRef: p })];
  for (const view of [...human, ...agentViews]) expect(JSON.stringify(view)).not.toContain("987654321");
  // The batch's events are there; only the reason is withheld. The owner still reads it.
  expect(JSON.stringify(human[0])).toContain(s.json.batch.id);
  expect(JSON.stringify(await w.client.query(api.events.forRecord, { orgId: w.orgId, recordId: p }))).toContain("secret amount 987654321");
});

it("unindexed count agrees between item and batch after Retry", async () => {
  const w = await workspace(), agent = await agentFor(w.client, w.orgId, { name: "Verifier" });
  const c = await w.create(w.company, { name: "C" }); await w.create(w.person, { name: "P", company: c });
  await w.t.run((ctx: any) => ctx.db.patch(w.person.fields.company._id, { slot: undefined }));
  const s = await rest(w.t, agent.key)("POST", "/api/v1/batches", { reason: "tidy", changes: [{ action: "delete", record: c }] }); await run(w.t);
  const counted = async () => [(await w.client.query(api.batches.list, { orgId: w.orgId }))[0].impact, (await w.client.query(api.batches.items, { orgId: w.orgId, batchId: s.json.batch.id, paginationOpts: { cursor: null, numItems: 10 } })).page[0].impact];
  expect(await counted()).toEqual([1, 1]);
  await w.client.mutation(api.batches.recount, { orgId: w.orgId, batchId: s.json.batch.id }); await run(w.t);
  expect(await counted()).toEqual([1, 1]);
  await w.client.mutation(api.batches.recount, { orgId: w.orgId, batchId: s.json.batch.id }); await run(w.t);
  expect(await counted()).toEqual([1, 1]);
});

it("cancelled count drivers finish without reviving a dismissed batch and stale failures cannot poison Retry", async () => {
  const w = await workspace(), agent = await agentFor(w.client, w.orgId, { name: "Verifier" });
  const c = await w.create(w.company, { name: "C" }); await w.create(w.person, { name: "P", company: c });
  const s = await rest(w.t, agent.key)("POST", "/api/v1/batches", { reason: "tidy", changes: [{ action: "delete", record: c }] });
  await w.client.mutation(api.batches.recount, { orgId: w.orgId, batchId: s.json.batch.id });
  await w.t.mutation(internal.batches.countFailed, { batchId: s.json.batch.id, run: 0 });
  expect((await w.client.query(api.batches.list, { orgId: w.orgId }))[0].countError).toBe(null);
  await w.client.mutation(api.batches.dismiss, { orgId: w.orgId, batchId: s.json.batch.id }); await run(w.t);
  expect((await w.client.query(api.batches.list, { orgId: w.orgId, status: "dismissed" }))[0].status).toBe("dismissed");
  expect(await w.get(c)).not.toBeNull();
});
