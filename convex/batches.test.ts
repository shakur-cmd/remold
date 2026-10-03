import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentFor, api, objectFields, rest, userAndOrg } from "./test.helpers";
import { internal } from "./_generated/api";
import { RemoldClient } from "../packages/mcp/src/client";

const run = (t: any) => t.finishAllScheduledFunctions(vi.runAllTimers);
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
afterEach(() => { vi.useRealTimers(); });

async function workspace() {
  const w = await userAndOrg();
  const opp = await objectFields(w.client, w.orgId, "opportunity"), person = await objectFields(w.client, w.orgId, "person"), company = await objectFields(w.client, w.orgId, "company"), campaign = await objectFields(w.client, w.orgId, "campaign");
  const create = async (o: any, values: Record<string, unknown>) => (await w.client.mutation(api.records.create, { orgId: w.orgId, objectId: o.object._id, values: Object.fromEntries(Object.entries(values).map(([k, v]) => [o.fields[k]._id, v])) })).recordId;
  const get = async (id: any): Promise<any> => (await w.client.query(api.records.get, { orgId: w.orgId, recordId: id }))?.record;
  const events = (id: any) => w.client.query(api.events.forRecord, { orgId: w.orgId, recordId: id });
  const tables = () => w.t.run(async (ctx: any) => ({ batches: await ctx.db.query("batches").collect(), items: await ctx.db.query("batchItems").collect() }));
  return { ...w, opp, person, company, campaign, create, get, events, tables };
}
const deals = async (w: any, n: number, stage = "new") => { const ids = []; for (let i = 0; i < n; i++) ids.push(await w.create(w.opp, { name: `Deal ${i}`, stage })); return ids; };
const stageAll = (ids: string[], stage: string) => ids.map((record) => ({ action: "update", record, values: { stage } }));

describe("batch proposals", () => {
  it("refuses the whole batch when one item is invalid, naming its index and message", async () => {
    const w = await workspace(), agent = await agentFor(w.client, w.orgId, { name: "Claude" }), call = rest(w.t, agent.key);
    const ids = await deals(w, 3);
    const [a, b, c] = stageAll(ids, "qualified");
    const response = await call("POST", "/api/v1/batches", { reason: "qualify", changes: [a, c, { ...b, values: { stage: "nope" } }, { action: "create", object: "company", values: { city: "Boston" } }] });
    expect(response.status).toBe(400);
    expect(response.json.error).toMatchObject({ code: "VALIDATION", items: [{ index: 2, code: "VALIDATION", message: "Invalid select option" }, { index: 3, code: "VALIDATION", message: "Name is required" }] });
    expect(await w.tables()).toEqual({ batches: [], items: [] });
    expect((await w.get(ids[0])).values[w.opp.fields.stage._id]).toBe("new");
  });

  it("refuses more than 1000 changes, an empty batch and the same record twice", async () => {
    const w = await workspace(), agent = await agentFor(w.client, w.orgId, { name: "Claude" }), call = rest(w.t, agent.key);
    const [id] = await deals(w, 1);
    expect((await call("POST", "/api/v1/batches", { reason: "x", changes: [] })).json.error).toMatchObject({ code: "VALIDATION", message: "A batch needs 1 to 1000 changes" });
    expect((await call("POST", "/api/v1/batches", { reason: "x", changes: Array.from({ length: 1001 }, (_, i) => ({ action: "create", object: "company", values: { name: `C${i}` } })) })).json.error).toMatchObject({ code: "VALIDATION", message: "A batch needs 1 to 1000 changes" });
    expect((await call("POST", "/api/v1/batches", { reason: "x", changes: [{ action: "update", record: id, values: { amount: 1 } }, { action: "update", record: id, values: { stage: "contacted" } }] })).json.error.items).toEqual([{ index: 1, code: "VALIDATION", message: "This record already has a change earlier in the batch" }]);
  });

  it("takes 1000 changes in one batch and applies every one", async () => {
    const w = await workspace(), agent = await agentFor(w.client, w.orgId, { name: "Claude" });
    const ids: string[] = [];
    await w.t.run(async (ctx: any) => { const member = (await ctx.db.query("members").collect())[0]; const { applyChange } = await import("./lib/applyChange"); const principal = { user: await ctx.db.get(member.userId), member, org: await ctx.db.get(w.orgId), actor: { kind: "user", id: member.userId } }; for (let i = 0; i < 1000; i++) ids.push((await applyChange(ctx, principal as any, { action: "create", orgId: w.orgId, objectId: w.opp.object._id, values: { [w.opp.fields.name._id]: `D${i}`, [w.opp.fields.stage._id]: "new" } })).recordId); });
    const posted = await rest(w.t, agent.key)("POST", "/api/v1/batches", { reason: "all of them", changes: stageAll(ids, "contacted") });
    expect(posted.json.batch).toMatchObject({ total: 1000, summary: "Update Stage on 1000 Opportunities" });
    await w.client.mutation(api.batches.apply, { orgId: w.orgId, batchId: posted.json.batch.id }); await run(w.t);
    expect((await rest(w.t, agent.key)("GET", `/api/v1/batches/${posted.json.batch.id}?limit=1`)).json.batch.progress).toEqual({ done: 1000, applied: 1000, conflicted: 0, failed: 0 });
    expect((await w.get(ids[999])).values[w.opp.fields.stage._id]).toBe("contacted");
  }, 120_000);

  it("enforces agent guards and protected fields per item", async () => {
    const w = await workspace(), agent = await agentFor(w.client, w.orgId, { name: "Claude" }), call = rest(w.t, agent.key);
    const [a, b] = await deals(w, 2, "proposal"), won = await w.create(w.opp, { name: "Won", stage: "won" });
    await w.client.mutation(api.fields.update, { orgId: w.orgId, fieldId: w.opp.fields.amount._id, protectedFromAgents: true });
    const response = await call("POST", "/api/v1/batches", { reason: "tidy", changes: [{ action: "update", record: a, values: { stage: "won" } }, { action: "update", record: b, values: { stage: "new" } }, { action: "update", record: won, values: { name: "Renamed" } }, { action: "update", record: await w.create(w.opp, { name: "C" }), values: { amount: 5 } }] });
    expect(response.status).toBe(403);
    expect(response.json.error.items).toEqual([
      { index: 1, code: "FORBIDDEN", message: "Agents can only move a stage forward" },
      { index: 3, code: "FORBIDDEN", message: "Amount is protected from agents; a person must change it" },
    ]);
    expect(await w.tables()).toEqual({ batches: [], items: [] });
  });

  it("refuses items outside the agent's proposal scope", async () => {
    const w = await workspace(), [id] = await deals(w, 1);
    const agent = await agentFor(w.client, w.orgId, { name: "Claude" });
    await w.t.run((ctx: any) => ctx.db.patch(agent.agentId, { readObjectIds: [w.company.object._id] }));
    const response = await rest(w.t, agent.key)("POST", "/api/v1/batches", { reason: "x", changes: [{ action: "create", object: "company", values: { name: "Ok" } }, { action: "update", record: id, values: { stage: "won" } }] });
    expect(response.json.error.items).toEqual([{ index: 1, code: "NOT_FOUND", message: "Object not found" }]);
  });

  it("shows one card with a summary and counts, applies in chunks with the person as actor, and attributes every event", async () => {
    const w = await workspace(), agent = await agentFor(w.client, w.orgId, { name: "Claude" }), call = rest(w.t, agent.key);
    const ids = await deals(w, 60);
    const posted = await call("POST", "/api/v1/batches", { reason: "Qualified after the webinar", changes: stageAll(ids, "Qualified") });
    expect(posted.status).toBe(201);
    expect(posted.json.batch).toMatchObject({ status: "pending", mode: "proposal", summary: "Update Stage on 60 Opportunities", counts: { create: 0, update: 60, delete: 0 }, total: 60, progress: { done: 0, applied: 0, conflicted: 0, failed: 0 } });
    const [card] = await w.client.query(api.batches.list, { orgId: w.orgId, status: "pending" });
    expect(card).toMatchObject({ _id: posted.json.batch.id, summary: "Update Stage on 60 Opportunities", agentName: "Claude", reason: "Qualified after the webinar", counts: { update: 60 } });
    const page = await w.client.query(api.batches.items, { orgId: w.orgId, batchId: card._id, paginationOpts: { cursor: null, numItems: 25 } });
    expect(page.page).toHaveLength(25); expect(page.isDone).toBe(false);
    expect(page.page[0]).toMatchObject({ index: 0, action: "update", recordTitle: "Deal 0", status: "queued", changes: [{ label: "Stage", before: "new", after: "qualified" }] });
    expect(await w.client.mutation(api.batches.apply, { orgId: w.orgId, batchId: card._id })).toMatchObject({ status: "applying" });
    await run(w.t);
    const [done] = await w.client.query(api.batches.list, { orgId: w.orgId, status: "done" });
    expect(done.progress).toEqual({ done: 60, applied: 60, conflicted: 0, failed: 0 });
    for (const id of [ids[0], ids[59]]) {
      expect((await w.get(id)).values[w.opp.fields.stage._id]).toBe("qualified");
      const events = await w.events(id);
      expect(events[0]).toMatchObject({ actor: { kind: "user" }, actorName: "A", batchId: card._id, reason: "Qualified after the webinar", proposedByName: "Claude" });
    }
    const status = await call("GET", `/api/v1/batches/${card._id}?limit=2`);
    expect(status.json).toMatchObject({ batch: { status: "done", progress: { done: 60, applied: 60 } }, items: [{ index: 0, status: "applied" }, { index: 1, status: "applied" }] });
    expect(status.json.nextCursor).toBeTruthy();
    expect(await w.client.mutation(api.batches.apply, { orgId: w.orgId, batchId: card._id })).toMatchObject({ status: "already" });
  });

  it("skips items whose record changed since review and applies the rest", async () => {
    const w = await workspace(), agent = await agentFor(w.client, w.orgId, { name: "Claude" });
    const ids = await deals(w, 4), gone = await w.create(w.opp, { name: "Gone", stage: "new" });
    const posted = await rest(w.t, agent.key)("POST", "/api/v1/batches", { reason: "q", changes: [...stageAll(ids, "qualified"), ...stageAll([gone], "qualified")] });
    await w.client.mutation(api.records.update, { orgId: w.orgId, recordId: ids[1], values: { [w.opp.fields.stage._id]: "proposal" } });
    await w.client.mutation(api.records.remove, { orgId: w.orgId, recordId: gone });
    await w.client.mutation(api.batches.apply, { orgId: w.orgId, batchId: posted.json.batch.id }); await run(w.t);
    expect((await w.get(ids[1])).values[w.opp.fields.stage._id]).toBe("proposal");
    expect((await w.get(ids[0])).values[w.opp.fields.stage._id]).toBe("qualified");
    expect((await w.get(ids[3])).values[w.opp.fields.stage._id]).toBe("qualified");
    const status = await rest(w.t, agent.key)("GET", `/api/v1/batches/${posted.json.batch.id}`);
    expect(status.json.batch.progress).toEqual({ done: 5, applied: 3, conflicted: 2, failed: 0 });
    expect(status.json.items[1]).toMatchObject({ status: "conflicted", conflicts: [{ field: "stage", expected: "new", actual: "proposal" }] });
    expect(status.json.items[4]).toMatchObject({ status: "conflicted" });
    const conflicted = await w.client.query(api.batches.items, { orgId: w.orgId, batchId: posted.json.batch.id, status: "conflicted", paginationOpts: { cursor: null, numItems: 10 } });
    expect(conflicted.page.map((item: any) => item.index)).toEqual([1, 4]);
  });

  it("records an item that fails at apply time as failed and still applies the others", async () => {
    const w = await workspace(), agent = await agentFor(w.client, w.orgId, { name: "Claude" });
    const ids = await deals(w, 3), acme = await w.create(w.company, { name: "Acme" });
    const posted = await rest(w.t, agent.key)("POST", "/api/v1/batches", { reason: "q", changes: [{ action: "update", record: ids[0], values: { stage: "qualified" } }, { action: "update", record: ids[1], values: { company: acme } }, { action: "update", record: ids[2], values: { stage: "qualified" } }] });
    await w.t.run((ctx: any) => ctx.db.delete(acme)); // the lookup target vanishes without the usual cleanup
    await w.client.mutation(api.batches.apply, { orgId: w.orgId, batchId: posted.json.batch.id }); await run(w.t);
    const status = await rest(w.t, agent.key)("GET", `/api/v1/batches/${posted.json.batch.id}`);
    expect(status.json.batch).toMatchObject({ status: "done", progress: { done: 3, applied: 2, conflicted: 0, failed: 1 } });
    expect(status.json.items[1]).toMatchObject({ status: "failed", error: "Invalid related record" });
    expect((await w.get(ids[2])).values[w.opp.fields.stage._id]).toBe("qualified");
  });

  it("still holds the agent's limits at apply time, failing an item a person approved meanwhile", async () => {
    const w = await workspace(), agent = await agentFor(w.client, w.orgId, { name: "Claude" }), post = await objectFields(w.client, w.orgId, "post");
    const draft = await w.create(post, { title: "Launch", status: "drafted" }), other = await w.create(post, { title: "Recap", status: "drafted" });
    const posted = await rest(w.t, agent.key)("POST", "/api/v1/batches", { reason: "punchier", changes: [{ action: "update", record: draft, values: { text: "New text" } }, { action: "update", record: other, values: { text: "Fresh" } }] });
    expect(posted.status).toBe(201);
    await w.client.mutation(api.records.update, { orgId: w.orgId, recordId: draft, values: { [post.fields.status._id]: "approved" } });
    await w.client.mutation(api.batches.apply, { orgId: w.orgId, batchId: posted.json.batch.id }); await run(w.t);
    const status = await rest(w.t, agent.key)("GET", `/api/v1/batches/${posted.json.batch.id}`);
    expect(status.json.items[0]).toMatchObject({ status: "failed", error: "Agents cannot change an approved or published post; a person must" });
    expect(status.json.items[1]).toMatchObject({ status: "applied" });
    expect((await w.get(draft)).values[post.fields.text._id]).toBeUndefined();
  });

  it("resumes after an interrupted run without applying anything twice", async () => {
    const w = await workspace(), agent = await agentFor(w.client, w.orgId, { name: "Claude" });
    const ids = await deals(w, 30);
    const posted = await rest(w.t, agent.key)("POST", "/api/v1/batches", { reason: "q", changes: stageAll(ids, "contacted") });
    const batchId = posted.json.batch.id;
    await w.client.mutation(api.batches.apply, { orgId: w.orgId, batchId });
    // The driver dies after one chunk: run that chunk, then drop the scheduled driver.
    await w.t.mutation(internal.batches.step, { batchId, size: 7 });
    await w.t.run(async (ctx: any) => { for (const job of await ctx.db.system.query("_scheduled_functions").collect()) if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id); });
    const [stuck] = await w.client.query(api.batches.list, { orgId: w.orgId, status: "applying" });
    expect(stuck.progress).toMatchObject({ done: 7, applied: 7 });
    // A repeated chunk finds the first seven applied and moves on.
    await w.t.mutation(internal.batches.step, { batchId, size: 3 });
    expect(await w.client.mutation(api.batches.apply, { orgId: w.orgId, batchId })).toMatchObject({ status: "applying" });
    expect(await w.client.mutation(api.batches.apply, { orgId: w.orgId, batchId })).toMatchObject({ status: "applying" });
    await run(w.t);
    const status = await rest(w.t, agent.key)("GET", `/api/v1/batches/${batchId}`);
    expect(status.json.batch).toMatchObject({ status: "done", progress: { done: 30, applied: 30, conflicted: 0, failed: 0 } });
    for (const id of ids) expect((await w.events(id)).filter((e: any) => e.batchId === batchId)).toHaveLength(1);
  });

  it("dismisses a batch without changing anything", async () => {
    const w = await workspace(), agent = await agentFor(w.client, w.orgId, { name: "Claude" });
    const ids = await deals(w, 2);
    const posted = await rest(w.t, agent.key)("POST", "/api/v1/batches", { reason: "q", changes: stageAll(ids, "won") });
    expect(await w.client.mutation(api.batches.dismiss, { orgId: w.orgId, batchId: posted.json.batch.id })).toMatchObject({ status: "dismissed" });
    expect(await w.client.mutation(api.batches.apply, { orgId: w.orgId, batchId: posted.json.batch.id })).toMatchObject({ status: "already" });
    await run(w.t);
    expect((await w.get(ids[0])).values[w.opp.fields.stage._id]).toBe("new");
    expect(await w.client.query(api.batches.list, { orgId: w.orgId, status: "pending" })).toEqual([]);
  });

  it("counts the links each delete would clear", async () => {
    const w = await workspace(), agent = await agentFor(w.client, w.orgId, { name: "Claude" });
    const acme = await w.create(w.company, { name: "Acme" }), lone = await w.create(w.company, { name: "Lone" });
    const ada = await w.create(w.person, { name: "Ada", company: acme }); await w.create(w.person, { name: "Ben", company: acme });
    await w.create(w.opp, { name: "Big", company: acme });
    await w.create(w.campaign, { name: "Spring", companies: [acme, lone] });
    const posted = await rest(w.t, agent.key)("POST", "/api/v1/batches", { reason: "dupes", changes: [{ action: "delete", record: acme }, { action: "delete", record: lone }, { action: "delete", record: ada }] });
    expect(posted.json.batch).toMatchObject({ summary: "Delete 2 Companies and 1 Person", counts: { create: 0, update: 0, delete: 3 } });
    // The agent is not told: the count includes links from records it may not read.
    expect(posted.json.batch.impact).toBeUndefined();
    expect((await w.client.query(api.batches.list, { orgId: w.orgId }))[0].impact).toBe(5);
    const page = await w.client.query(api.batches.items, { orgId: w.orgId, batchId: posted.json.batch.id, paginationOpts: { cursor: null, numItems: 10 } });
    expect(page.page.map((item: any) => item.impact)).toEqual([4, 1, 0]);
  });

  it("deletes records in one batch even when an earlier delete cleared their links", async () => {
    const w = await workspace(), agent = await agentFor(w.client, w.orgId, { name: "Claude" });
    const acme = await w.create(w.company, { name: "Acme" }), ada = await w.create(w.person, { name: "Ada", company: acme }), spring = await w.create(w.campaign, { name: "Spring", companies: [acme] });
    const posted = await rest(w.t, agent.key)("POST", "/api/v1/batches", { reason: "dupes", changes: [{ action: "delete", record: acme }, { action: "delete", record: ada }, { action: "delete", record: spring }] });
    await w.client.mutation(api.batches.apply, { orgId: w.orgId, batchId: posted.json.batch.id }); await run(w.t);
    expect((await rest(w.t, agent.key)("GET", `/api/v1/batches/${posted.json.batch.id}`)).json.batch.progress).toEqual({ done: 3, applied: 3, conflicted: 0, failed: 0 });
    expect(await w.get(ada)).toBeUndefined();
  });

  it("holds the agent's limits on reference cleanup when a person applies its delete", async () => {
    const w = await workspace(), agent = await agentFor(w.client, w.orgId, { name: "Claude" });
    const acme = await w.create(w.company, { name: "Acme" }), ada = await w.create(w.person, { name: "Ada", company: acme });
    await w.client.mutation(api.fields.update, { orgId: w.orgId, fieldId: w.person.fields.company._id, protectedFromAgents: true });
    const posted = await rest(w.t, agent.key)("POST", "/api/v1/batches", { reason: "dupe", changes: [{ action: "delete", record: acme }] });
    await w.client.mutation(api.batches.apply, { orgId: w.orgId, batchId: posted.json.batch.id }); await run(w.t);
    expect((await rest(w.t, agent.key)("GET", `/api/v1/batches/${posted.json.batch.id}`)).json.items[0]).toMatchObject({ status: "failed", error: "Company is protected from agents; a person must change it" });
    expect((await w.get(ada)).values[w.person.fields.company._id]).toBe(acme);
  });

  it("stops an approved batch when the agent is revoked mid-run, and the rest can be dismissed", async () => {
    const w = await workspace(), agent = await agentFor(w.client, w.orgId, { name: "Claude" });
    const ids = await deals(w, 30);
    const posted = await rest(w.t, agent.key)("POST", "/api/v1/batches", { reason: "q", changes: stageAll(ids, "won") });
    const batchId = posted.json.batch.id;
    await w.client.mutation(api.batches.apply, { orgId: w.orgId, batchId });
    await w.t.mutation(internal.batches.step, { batchId, size: 5 });
    await w.client.mutation(api.agents.revoke, { orgId: w.orgId, agentId: agent.agentId });
    await run(w.t);
    const [stopped] = await w.client.query(api.batches.list, { orgId: w.orgId, status: "stopped" });
    expect(stopped).toMatchObject({ paused: true, progress: { applied: 5 }, error: "This agent's access changed since it asked. Dismiss the rest of the batch." });
    await expect(w.client.mutation(api.batches.apply, { orgId: w.orgId, batchId })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
    expect(await w.client.mutation(api.batches.dismiss, { orgId: w.orgId, batchId })).toMatchObject({ status: "dismissed" });
    expect((await w.get(ids[29])).values[w.opp.fields.stage._id]).toBe("new");
  });
});

describe("link deltas", () => {
  it("adds people to a campaign without dropping a person a teammate added meanwhile", async () => {
    const w = await workspace(), agent = await agentFor(w.client, w.orgId, { name: "Claude" });
    const [ada, ben, cy, dee] = [await w.create(w.person, { name: "Ada" }), await w.create(w.person, { name: "Ben" }), await w.create(w.person, { name: "Cy" }), await w.create(w.person, { name: "Dee" })];
    const spring = await w.create(w.campaign, { name: "Spring", people: [dee] });
    const posted = await rest(w.t, agent.key)("POST", "/api/v1/batches", { reason: "webinar list", changes: [{ action: "update", record: spring, links: { people: { add: [ada, "Ben"], remove: [dee] } } }] });
    expect(posted.json.batch.summary).toBe("Add 2 and remove 1 People on Spring");
    await w.client.mutation(api.records.update, { orgId: w.orgId, recordId: spring, values: { [w.campaign.fields.people._id]: [dee, cy] } });
    await w.client.mutation(api.batches.apply, { orgId: w.orgId, batchId: posted.json.batch.id }); await run(w.t);
    expect((await w.get(spring)).values[w.campaign.fields.people._id]).toEqual([cy, ada, ben]);
    const status = await rest(w.t, agent.key)("GET", `/api/v1/batches/${posted.json.batch.id}`);
    expect(status.json.batch.progress).toMatchObject({ applied: 1, conflicted: 0 });
    expect(status.json.items[0].links.people.add.map((p: any) => p.title)).toEqual(["Ada", "Ben"]);
  });

  it("summarises adding people to one campaign", async () => {
    const w = await workspace(), agent = await agentFor(w.client, w.orgId, { name: "Claude" });
    const people = []; for (let i = 0; i < 3; i++) people.push(await w.create(w.person, { name: `P${i}` }));
    const spring = await w.create(w.campaign, { name: "Spring" });
    const posted = await rest(w.t, agent.key)("POST", "/api/v1/batches", { reason: "x", changes: [{ action: "update", record: spring, links: { people: { add: people } } }] });
    expect(posted.json.batch.summary).toBe("Add 3 People to Spring");
  });

  it("applies a single suggestion's link delta on top of the current links", async () => {
    const w = await workspace(), agent = await agentFor(w.client, w.orgId, { name: "Claude" });
    const [ada, ben] = [await w.create(w.person, { name: "Ada" }), await w.create(w.person, { name: "Ben" })];
    const spring = await w.create(w.campaign, { name: "Spring" });
    const proposed = await rest(w.t, agent.key)("POST", "/api/v1/suggestions", { action: "update", record: spring, values: { goal: "Fill the room" }, links: { people: { add: ["Ada"] } }, reason: "she asked" });
    expect(proposed.status).toBe(201);
    expect(proposed.json.suggestion.links).toEqual({ people: { add: [expect.objectContaining({ title: "Ada" })], remove: [] } });
    await w.client.mutation(api.records.update, { orgId: w.orgId, recordId: spring, values: { [w.campaign.fields.people._id]: [ben] } });
    expect(await w.client.mutation(api.suggestions.apply, { orgId: w.orgId, suggestionId: proposed.json.suggestion.id })).toMatchObject({ status: "applied" });
    expect((await w.get(spring)).values).toMatchObject({ [w.campaign.fields.people._id]: [ben, ada], [w.campaign.fields.goal._id]: "Fill the room" });
  });

  it("keeps a suggestion's link delta when a person adopts it", async () => {
    const w = await workspace(), agent = await agentFor(w.client, w.orgId, { name: "Claude" });
    const ada = await w.create(w.person, { name: "Ada" }), spring = await w.create(w.campaign, { name: "Spring" });
    const proposed = await rest(w.t, agent.key)("POST", "/api/v1/suggestions", { action: "update", record: spring, links: { people: { add: [ada] } }, reason: "x" });
    const adopted = await w.client.mutation(api.suggestions.adopt, { orgId: w.orgId, suggestionId: proposed.json.suggestion.id });
    expect((await w.client.query(api.suggestions.list, { orgId: w.orgId })).find((row: any) => row.suggestion._id === adopted)!.suggestion.change.links).toEqual({ [w.campaign.fields.people._id]: { add: [ada], remove: [] } });
    await w.client.mutation(api.suggestions.apply, { orgId: w.orgId, suggestionId: adopted });
    expect((await w.get(spring)).values[w.campaign.fields.people._id]).toEqual([ada]);
  });

  it("applies a direct change's link delta and refuses a non-links field or the same person twice", async () => {
    const w = await workspace(), agent = await agentFor(w.client, w.orgId, { name: "Claude", grants: [{ action: "update", objectKey: "campaign" }] }), call = rest(w.t, agent.key);
    const [ada, ben] = [await w.create(w.person, { name: "Ada" }), await w.create(w.person, { name: "Ben" })];
    const spring = await w.create(w.campaign, { name: "Spring", people: [ben] });
    const changed = await call("POST", "/api/v1/changes", { action: "update", record: spring, links: { people: { add: [ada] } }, reason: "joined" });
    expect(changed.status).toBe(200);
    expect(changed.json.record.values.people.map((p: any) => p.title)).toEqual(["Ben", "Ada"]);
    expect((await call("POST", "/api/v1/changes", { action: "update", record: spring, links: { name: { add: [ada] } }, reason: "x" })).json.error).toMatchObject({ code: "VALIDATION", message: "name is not a links field" });
    expect((await call("POST", "/api/v1/changes", { action: "update", record: spring, links: { people: { add: [ada], remove: [ada] } }, reason: "x" })).json.error).toMatchObject({ code: "VALIDATION", message: "A record cannot be both added and removed" });
    expect((await call("POST", "/api/v1/changes", { action: "update", record: spring, values: { people: [] }, links: { people: { add: [ada] } }, reason: "x" })).json.error).toMatchObject({ code: "VALIDATION", message: "people is in both values and links" });
  });
});

describe("direct batches", () => {
  it("applies a granted batch at once, replays its Idempotency-Key, and is attributed to the agent", async () => {
    const w = await workspace(), agent = await agentFor(w.client, w.orgId, { name: "Claude", grants: [{ action: "create", objectKey: "company" }, { action: "update", objectKey: "opportunity" }] });
    const [deal] = await deals(w, 1);
    const body = { reason: "import", direct: true, changes: [{ action: "create", object: "company", values: { name: "Northwind" } }, { action: "update", record: deal, values: { stage: "contacted" } }] };
    const send = (b: unknown, key = "batch-1") => w.t.fetch("/api/v1/batches", { method: "POST", headers: { authorization: `Bearer ${agent.key}`, "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(b) }).then(async (r: Response) => ({ status: r.status, json: await r.json() }));
    const first = await send(body);
    expect(first.status).toBe(201);
    expect(first.json.batch).toMatchObject({ mode: "direct", status: "applying" });
    await run(w.t);
    const again = await send(body);
    expect(again.json.batch).toMatchObject({ id: first.json.batch.id, status: "done", progress: { applied: 2 } });
    expect((await send({ ...body, reason: "other" })).status).toBe(422);
    await run(w.t);
    const companies = await w.client.query(api.records.list, { orgId: w.orgId, objectId: w.company.object._id, paginationOpts: { cursor: null, numItems: 50 } });
    expect(companies.page.filter((r: any) => r.title === "Northwind")).toHaveLength(1);
    expect((await w.events(deal))[0]).toMatchObject({ actor: { kind: "agent", id: agent.agentId }, batchId: first.json.batch.id, reason: "import" });
    expect(await w.client.query(api.batches.list, { orgId: w.orgId, status: "pending" })).toEqual([]);
  });

  it("refuses a direct batch when any item lacks a grant, naming the item", async () => {
    const w = await workspace(), agent = await agentFor(w.client, w.orgId, { name: "Claude", grants: [{ action: "update", objectKey: "opportunity" }] });
    const [deal] = await deals(w, 1);
    const response = await rest(w.t, agent.key)("POST", "/api/v1/batches", { reason: "x", direct: true, changes: [{ action: "update", record: deal, values: { stage: "contacted" } }, { action: "create", object: "company", values: { name: "Nope" } }] });
    expect(response.status).toBe(403);
    expect(response.json.error).toMatchObject({ code: "FORBIDDEN", items: [{ index: 1, code: "FORBIDDEN", message: "No grant for create:company. Propose it instead." }] });
    await run(w.t);
    expect(await w.tables()).toEqual({ batches: [], items: [] });
    expect((await w.get(deal)).values[w.opp.fields.stage._id]).toBe("new");
  });
});

describe("who may apply", () => {
  async function member(w: any, readScopes?: unknown) {
    const invite = await w.client.mutation(api.invites.create, { orgId: w.orgId, role: "member" });
    const client = w.t.withIdentity({ tokenIdentifier: "clerk|m", name: "M" });
    await client.mutation(api.users.store, {}); await client.mutation(api.invites.accept, { token: invite.token });
    if (readScopes) await w.t.run(async (ctx: any) => { const row = (await ctx.db.query("members").collect()).find((m: any) => m.role === "member"); await ctx.db.patch(row._id, { readScopes }); });
    return client;
  }

  it("a member-role person cannot see or apply a batch touching an object they cannot write", async () => {
    const w = await workspace(), agent = await agentFor(w.client, w.orgId, { name: "Claude" });
    const ids = await deals(w, 2);
    const posted = await rest(w.t, agent.key)("POST", "/api/v1/batches", { reason: "q", changes: [...stageAll(ids, "won"), { action: "create", object: "company", values: { name: "New Co" } }] });
    const m = await member(w, [{ objectId: w.company.object._id, records: "all", fields: "all" }]);
    expect(await m.query(api.batches.list, { orgId: w.orgId, status: "pending" })).toEqual([]);
    await expect(m.mutation(api.batches.apply, { orgId: w.orgId, batchId: posted.json.batch.id })).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
    await expect(m.mutation(api.batches.dismiss, { orgId: w.orgId, batchId: posted.json.batch.id })).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
    await run(w.t);
    expect((await w.get(ids[0])).values[w.opp.fields.stage._id]).toBe("new");
  });

  it("a member-role person with full access applies, and the events name them", async () => {
    const w = await workspace(), agent = await agentFor(w.client, w.orgId, { name: "Claude" });
    const ids = await deals(w, 2);
    const posted = await rest(w.t, agent.key)("POST", "/api/v1/batches", { reason: "q", changes: stageAll(ids, "won") });
    const m = await member(w);
    expect(await m.mutation(api.batches.apply, { orgId: w.orgId, batchId: posted.json.batch.id })).toMatchObject({ status: "applying" });
    await run(w.t);
    expect((await w.events(ids[1]))[0]).toMatchObject({ actorName: "M", proposedByName: "Claude" });
  });

  it("a person with a hidden field the batch writes cannot apply it", async () => {
    const w = await workspace(), agent = await agentFor(w.client, w.orgId, { name: "Claude" });
    const ids = await deals(w, 1);
    const posted = await rest(w.t, agent.key)("POST", "/api/v1/batches", { reason: "q", changes: stageAll(ids, "won") });
    const m = await member(w);
    await w.t.run(async (ctx: any) => { const row = (await ctx.db.query("members").collect()).find((x: any) => x.role === "member"); await ctx.db.patch(row._id, { hiddenFieldIds: [w.opp.fields.stage._id] }); });
    await expect(m.mutation(api.batches.apply, { orgId: w.orgId, batchId: posted.json.batch.id })).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
  });

  it("a person who sees a field only on some records cannot see a batch writing it on others", async () => {
    const w = await workspace(), agent = await agentFor(w.client, w.orgId, { name: "Claude" });
    const [a, b] = await deals(w, 2);
    const posted = await rest(w.t, agent.key)("POST", "/api/v1/batches", { reason: "q", changes: [{ action: "update", record: b, values: { amount: 999 } }] });
    const f = w.opp.fields, m = await member(w, [{ objectId: w.opp.object._id, records: "all", fields: [f.name._id, f.stage._id] }, { objectId: w.opp.object._id, records: [a], fields: "all" }]);
    expect(await m.query(api.batches.list, { orgId: w.orgId, status: "pending" })).toEqual([]);
    await expect(m.query(api.batches.items, { orgId: w.orgId, batchId: posted.json.batch.id, paginationOpts: { cursor: null, numItems: 5 } })).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
  });

  it("does not show a conflict on a field the reader cannot see", async () => {
    const w = await workspace(), agent = await agentFor(w.client, w.orgId, { name: "Claude" });
    const deal = await w.create(w.opp, { name: "Quiet" });
    const posted = await rest(w.t, agent.key)("POST", "/api/v1/batches", { reason: "q", changes: [{ action: "delete", record: deal }] });
    await w.client.mutation(api.records.update, { orgId: w.orgId, recordId: deal, values: { [w.opp.fields.amount._id]: 123456 } });
    await w.client.mutation(api.batches.apply, { orgId: w.orgId, batchId: posted.json.batch.id }); await run(w.t);
    const m = await member(w);
    await w.t.run(async (ctx: any) => { const row = (await ctx.db.query("members").collect()).find((x: any) => x.role === "member"); await ctx.db.patch(row._id, { hiddenFieldIds: [w.opp.fields.amount._id] }); });
    const page = await m.query(api.batches.items, { orgId: w.orgId, batchId: posted.json.batch.id, paginationOpts: { cursor: null, numItems: 5 } });
    expect(page.page[0]).toMatchObject({ status: "conflicted", conflicts: [] });
    expect(JSON.stringify(page)).not.toContain("123456");
    expect((await w.client.query(api.batches.items, { orgId: w.orgId, batchId: posted.json.batch.id, paginationOpts: { cursor: null, numItems: 5 } })).page[0].conflicts).toEqual([{ fieldId: w.opp.fields.amount._id, expected: null, actual: 123456 }]);
  });

  it("names a record in a summary only for readers who may see its title", async () => {
    const w = await workspace(), agent = await agentFor(w.client, w.orgId, { name: "Claude" });
    const ada = await w.create(w.person, { name: "Ada" }), secret = await w.create(w.campaign, { name: "Project Falcon" });
    await w.t.run((ctx: any) => ctx.db.patch(agent.agentId, { hiddenFieldIds: [w.campaign.fields.name._id] }));
    const posted = await rest(w.t, agent.key)("POST", "/api/v1/batches", { reason: "x", changes: [{ action: "update", record: secret, links: { people: { add: [ada] } } }] });
    expect(posted.json.batch.summary).toBe("Add 1 Person to a record");
    expect(JSON.stringify(posted.json)).not.toContain("Falcon");
    expect((await w.client.query(api.batches.list, { orgId: w.orgId }))[0].summary).toBe("Add 1 Person to Project Falcon");
  });

  it("refuses a batch from an agent whose access was revoked", async () => {
    const w = await workspace(), agent = await agentFor(w.client, w.orgId, { name: "Claude" });
    const ids = await deals(w, 1);
    const posted = await rest(w.t, agent.key)("POST", "/api/v1/batches", { reason: "q", changes: stageAll(ids, "won") });
    await w.client.mutation(api.agents.revoke, { orgId: w.orgId, agentId: agent.agentId });
    expect((await w.client.query(api.batches.list, { orgId: w.orgId, status: "pending" }))[0].paused).toBe(true);
    await expect(w.client.mutation(api.batches.apply, { orgId: w.orgId, batchId: posted.json.batch.id })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
  });

  it("refuses new batches and applies while the workspace is read only, but still dismisses", async () => {
    const w = await workspace(), agent = await agentFor(w.client, w.orgId, { name: "Claude" });
    const ids = await deals(w, 1);
    const posted = await rest(w.t, agent.key)("POST", "/api/v1/batches", { reason: "q", changes: stageAll(ids, "won") });
    await w.t.run((ctx: any) => ctx.db.patch(w.orgId, { flags: { readonly: true } }));
    expect((await rest(w.t, agent.key)("POST", "/api/v1/batches", { reason: "q", changes: stageAll(ids, "won") })).status).toBe(403);
    await expect(w.client.mutation(api.batches.apply, { orgId: w.orgId, batchId: posted.json.batch.id })).rejects.toMatchObject({ data: { code: "FORBIDDEN", message: "Workspace is read only" } });
    expect(await w.client.mutation(api.batches.dismiss, { orgId: w.orgId, batchId: posted.json.batch.id })).toMatchObject({ status: "dismissed" });
  });

  it("stops an applying batch when the workspace turns read only and resumes it later", async () => {
    const w = await workspace(), agent = await agentFor(w.client, w.orgId, { name: "Claude" });
    const ids = await deals(w, 3);
    const posted = await rest(w.t, agent.key)("POST", "/api/v1/batches", { reason: "q", changes: stageAll(ids, "won") });
    await w.client.mutation(api.batches.apply, { orgId: w.orgId, batchId: posted.json.batch.id });
    await w.t.run((ctx: any) => ctx.db.patch(w.orgId, { flags: { readonly: true } }));
    await run(w.t);
    const [stopped] = await w.client.query(api.batches.list, { orgId: w.orgId, status: "stopped" });
    expect(stopped).toMatchObject({ error: "Workspace is read only", progress: { done: 0 } });
    expect((await w.get(ids[0])).values[w.opp.fields.stage._id]).toBe("new");
    await w.t.run((ctx: any) => ctx.db.patch(w.orgId, { flags: {} }));
    expect(await w.client.mutation(api.batches.apply, { orgId: w.orgId, batchId: posted.json.batch.id })).toMatchObject({ status: "applying" });
    await run(w.t);
    expect((await w.client.query(api.batches.list, { orgId: w.orgId, status: "done" }))[0].progress).toMatchObject({ applied: 3 });
  });

  it("only the submitting agent reads a batch over REST", async () => {
    const w = await workspace(), agent = await agentFor(w.client, w.orgId, { name: "Claude" }), other = await agentFor(w.client, w.orgId, { name: "Other" });
    const ids = await deals(w, 1);
    const posted = await rest(w.t, agent.key)("POST", "/api/v1/batches", { reason: "q", changes: stageAll(ids, "won") });
    expect((await rest(w.t, other.key)("GET", `/api/v1/batches/${posted.json.batch.id}`)).status).toBe(404);
    expect((await rest(w.t, other.key)("GET", "/api/v1/batches/nonsense")).status).toBe(404);
  });
});

describe("MCP batches", () => {
  it("an agent proposes a batch, applies a granted one and reads both through the real REST client", async () => {
    const w = await workspace(), agent = await agentFor(w.client, w.orgId, { name: "Claude", grants: [{ action: "update", objectKey: "campaign" }] });
    const client = new RemoldClient({ url: "https://remold.test", key: agent.key, fetch: (async (input: RequestInfo | URL, init?: RequestInit) => { const url = new URL(String(input)); return w.t.fetch(url.pathname + url.search, init); }) as typeof fetch });
    const ids = await deals(w, 3), ada = await w.create(w.person, { name: "Ada" }), spring = await w.create(w.campaign, { name: "Spring" });
    const proposed = await client.proposeBatch({ reason: "qualify", changes: stageAll(ids, "qualified") });
    expect(proposed.batch).toMatchObject({ status: "pending", summary: "Update Stage on 3 Opportunities" });
    const applied = await client.applyBatch({ reason: "list", changes: [{ action: "update", record: spring, links: { people: { add: ["Ada"] } } }], idempotencyKey: "k1" });
    expect(applied.batch).toMatchObject({ mode: "direct", summary: "Add 1 Person to Spring" });
    await run(w.t);
    expect((await client.batchStatus({ id: applied.batch.id })).batch.status).toBe("done");
    expect((await w.get(spring)).values[w.campaign.fields.people._id]).toEqual([ada]);
    const page = await client.batchStatus({ id: proposed.batch.id, limit: 2 });
    expect(page.items.map((item: any) => item.index)).toEqual([0, 1]);
    expect((await client.batchStatus({ id: proposed.batch.id, cursor: page.nextCursor })).items.map((item: any) => item.index)).toEqual([2]);
  });
});
