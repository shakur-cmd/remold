import { describe, expect, it } from "vitest";
import { anyApi } from "convex/server";
import { agentFor, api, objectFields, rest, userAndOrg } from "./test.helpers";
import { RemoldClient } from "../packages/mcp/src/client";

const shape = anyApi.shapeSuggestions;
const propose = (call: ReturnType<typeof rest>, body: Record<string, unknown>) => call("POST", "/api/v1/shape/proposals", { reason: "the team tracks this", ...body });
const fieldsOf = async (f: Awaited<ReturnType<typeof userAndOrg>>, key: string) => Object.keys((await objectFields(f.client, f.orgId, key)).fields).sort();
const pendingRows = (f: Awaited<ReturnType<typeof userAndOrg>>) => f.client.query(shape.list, { orgId: f.orgId, status: "pending" });
async function joined(f: Awaited<ReturnType<typeof userAndOrg>>, name: string, role: "admin" | "member") {
  const { token } = await f.client.mutation(api.invites.create, { orgId: f.orgId, role });
  const client = f.t.withIdentity({ tokenIdentifier: `clerk|${name}`, name }); await client.mutation(api.users.store, {}); await client.mutation(api.invites.accept, { token });
  const memberId = await f.t.run(async (ctx: any) => { const user = await ctx.db.query("users").withIndex("by_token", (q: any) => q.eq("tokenIdentifier", `clerk|${name}`)).unique(); return (await ctx.db.query("members").withIndex("by_org_user", (q: any) => q.eq("orgId", f.orgId).eq("userId", user._id)).unique())._id; });
  return { client, memberId };
}
async function adminAgent(name = "shaper") { const f = await userAndOrg(); const agent = await agentFor(f.client, f.orgId, { name, role: "admin" }); return { f, agent, call: rest(f.t, agent.key) }; }

describe("agents propose shape changes", () => {
  it("refuses a member-role agent and stores nothing", async () => {
    const f = await userAndOrg(), agent = await agentFor(f.client, f.orgId, { name: "helper" });
    const refused = await propose(rest(f.t, agent.key), { kind: "addField", object: "opportunity", key: "budget", label: "Budget", type: "number" });
    expect(refused.status).toBe(403);
    expect(refused.json.error.code).toBe("FORBIDDEN");
    expect(await pendingRows(f)).toEqual([]);
  });

  it("stores an admin agent's proposal without changing the shape", async () => {
    const { f, call } = await adminAgent();
    const before = await fieldsOf(f, "opportunity");
    const made = await propose(call, { kind: "addField", object: "opportunity", key: "budget", label: "Budget", type: "number" });
    expect(made.status).toBe(201);
    expect(made.json.proposal).toMatchObject({ kind: "addField", status: "pending", summary: "Add field Budget (number) to Opportunity", reason: "the team tracks this" });
    expect(await fieldsOf(f, "opportunity")).toEqual(before);
    expect((await pendingRows(f)).map((row: any) => [row.summary, row.agentName])).toEqual([["Add field Budget (number) to Opportunity", "shaper"]]);
  });
});

// Each rule is checked twice: the person's own mutation and the agent's proposal must refuse with the same message.
describe("proposals are refused by the same rules as the person's path", () => {
  async function both(human: (f: Awaited<ReturnType<typeof userAndOrg>>, ids: any) => Promise<unknown>, body: (ids: any) => Record<string, unknown>, setup?: (f: Awaited<ReturnType<typeof userAndOrg>>) => Promise<void>) {
    const f = await userAndOrg(); const agent = await agentFor(f.client, f.orgId, { name: "shaper", role: "admin" });
    await setup?.(f);
    const opportunity = await objectFields(f.client, f.orgId, "opportunity"), ids = { opportunity, f };
    const personError = await human(f, ids).then(() => null, (error: any) => error.data?.message);
    const agentReply = await propose(rest(f.t, agent.key), body(ids));
    expect(personError).toBeTruthy();
    expect(agentReply.status).toBeGreaterThanOrEqual(400);
    expect(await pendingRows(f)).toEqual([]);
    return { personError, agentError: agentReply.json.error.message, agentStatus: agentReply.status };
  }
  it("bad key", async () => {
    const r = await both((f, { opportunity }) => f.client.mutation(api.fields.create, { orgId: f.orgId, objectId: opportunity.object._id, key: "Bad key", label: "Bad", type: "text" }), () => ({ kind: "addField", object: "opportunity", key: "Bad key", label: "Bad", type: "text" }));
    expect(r).toMatchObject({ personError: "Invalid field key", agentError: "Invalid field key" });
    const o = await both((f) => f.client.mutation(api.objects.create, { orgId: f.orgId, key: "9lives", label: "Cat", labelPlural: "Cats" }), () => ({ kind: "addObject", key: "9lives", label: "Cat", labelPlural: "Cats" }));
    expect(o).toMatchObject({ personError: "Invalid object key", agentError: "Invalid object key" });
  });
  it("duplicate key", async () => {
    const r = await both((f, { opportunity }) => f.client.mutation(api.fields.create, { orgId: f.orgId, objectId: opportunity.object._id, key: "amount", label: "Again", type: "number" }), () => ({ kind: "addField", object: "opportunity", key: "amount", label: "Again", type: "number" }));
    expect(r).toMatchObject({ personError: "Field key already exists", agentError: "Field key already exists" });
    const o = await both((f) => f.client.mutation(api.objects.create, { orgId: f.orgId, key: "company", label: "Company", labelPlural: "Companies" }), () => ({ kind: "addObject", key: "company", label: "Company", labelPlural: "Companies" }));
    expect(o).toMatchObject({ personError: "Object key already exists", agentError: "Object key already exists" });
  });
  it("select without options", async () => {
    const r = await both((f, { opportunity }) => f.client.mutation(api.fields.create, { orgId: f.orgId, objectId: opportunity.object._id, key: "tier", label: "Tier", type: "select" }), () => ({ kind: "addField", object: "opportunity", key: "tier", label: "Tier", type: "select" }));
    expect(r).toMatchObject({ personError: "Select needs unique options", agentError: "Select needs unique options" });
  });
  it("withTime on a field that is not a date", async () => {
    const r = await both((f, { opportunity }) => f.client.mutation(api.fields.create, { orgId: f.orgId, objectId: opportunity.object._id, key: "score", label: "Score", type: "number", withTime: true }), () => ({ kind: "addField", object: "opportunity", key: "score", label: "Score", type: "number", withTime: true }));
    expect(r).toMatchObject({ personError: "Only date fields keep time", agentError: "Only date fields keep time" });
  });
  it("a relation to an object the proposer cannot read", async () => {
    // The agent exists before Vault, so it cannot read Vault; the person is scoped to Opportunity only.
    let vault: any;
    const r = await both((f, { opportunity }) => f.client.mutation(api.fields.create, { orgId: f.orgId, objectId: opportunity.object._id, key: "vault", label: "Vault", type: "lookup", targetObjectId: vault }), () => ({ kind: "addField", object: "opportunity", key: "vault", label: "Vault", type: "lookup", target: "vault" }), async (f) => {
      vault = await f.client.mutation(api.objects.create, { orgId: f.orgId, key: "vault", label: "Vault", labelPlural: "Vaults" });
      const opportunity = await objectFields(f.client, f.orgId, "opportunity"), memberId = await f.t.run(async (ctx: any) => (await ctx.db.query("members").collect())[0]._id);
      await f.client.mutation(anyApi["authority/policies"].setMember, { orgId: f.orgId, memberId, scopes: [{ objectId: opportunity.object._id, records: "all", fields: "all" }], hiddenFieldIds: [] });
    });
    expect(r).toMatchObject({ personError: "Object not found", agentError: "Object not found" });
  });
  it("removing an existing option", async () => {
    const r = await both((f, { opportunity }) => f.client.mutation(api.fields.update, { orgId: f.orgId, fieldId: opportunity.fields.stage._id, options: [{ id: "won", label: "Won" }] }), () => ({ kind: "addOptions", object: "opportunity", field: "stage", options: [{ id: "won", label: "Won" }] }));
    expect(r).toMatchObject({ personError: "Options cannot be removed", agentError: "Options cannot be removed" });
  });
  it("a lookup with no index slot left", async () => {
    const r = await both((f, { opportunity }) => f.client.mutation(api.fields.create, { orgId: f.orgId, objectId: opportunity.object._id, key: "partner", label: "Partner", type: "lookup", targetObjectId: opportunity.fields.company.targetObjectId }), () => ({ kind: "addField", object: "opportunity", key: "partner", label: "Partner", type: "lookup", target: "company" }), async (f) => {
      const opportunity = await objectFields(f.client, f.orgId, "opportunity");
      for (let i = 0; i < 8; i++) await f.client.mutation(api.fields.create, { orgId: f.orgId, objectId: opportunity.object._id, key: `note${i}`, label: `Note ${i}`, type: "text" });
    });
    expect(r.agentError).toBe(r.personError);
    expect(r.personError).toMatch(/slot/i);
    expect(r.agentStatus).toBe(409);
  });
});

describe("a person applies or dismisses shape proposals", () => {
  it("applies a new field exactly once and attributes it", async () => {
    const { f, agent, call } = await adminAgent();
    const made = (await propose(call, { kind: "addField", object: "opportunity", key: "budget", label: "Budget", type: "number" })).json.proposal;
    const before = await fieldsOf(f, "opportunity");
    const applied = await f.client.mutation(shape.apply, { orgId: f.orgId, id: made.id });
    expect(applied.status).toBe("applied");
    expect(await fieldsOf(f, "opportunity")).toEqual([...before, "budget"].sort());
    const budget = (await objectFields(f.client, f.orgId, "opportunity")).fields.budget;
    expect(budget).toMatchObject({ label: "Budget", type: "number", required: false });
    expect(budget.slot).toBeDefined();
    const user = await f.client.query(api.users.me, {});
    const audit: any[] = await f.t.run((ctx: any) => ctx.db.query("authorityAudit").collect());
    expect(audit.filter((row: any) => row.targetId === made.id)).toEqual([expect.objectContaining({ action: "shapeProposalApplied", actor: { kind: "user", id: user!._id }, objectIds: [budget.objectId] })]);
    const listed = (await call("GET", "/api/v1/shape/proposals?status=applied")).json.proposals;
    expect(listed).toEqual([expect.objectContaining({ id: made.id, status: "applied", result: { object: "opportunity", fields: ["budget"] } })]);
    expect((await call("GET", "/api/v1/objects")).json.find((o: any) => o.key === "opportunity").fields.some((x: any) => x.key === "budget")).toBe(true);
    expect((await f.client.mutation(shape.apply, { orgId: f.orgId, id: made.id })).status).toBe("already");
    expect(await fieldsOf(f, "opportunity")).toEqual([...before, "budget"].sort());
    void agent;
  });

  it("applies a new object with its fields, and the proposer can then use it", async () => {
    const { f, call } = await adminAgent();
    const made = (await propose(call, { kind: "addObject", key: "venue", label: "Venue", labelPlural: "Venues", fields: [{ key: "capacity", label: "Capacity", type: "number" }, { key: "kind", label: "Kind", type: "select", options: [{ id: "hall", label: "Hall" }, { id: "bar", label: "Bar" }] }, { key: "owner", label: "Owner", type: "lookup", target: "company" }] })).json.proposal;
    expect(made.summary).toBe("Add object Venue with 3 fields");
    expect((await call("GET", "/api/v1/objects")).json.some((o: any) => o.key === "venue")).toBe(false);
    await f.client.mutation(shape.apply, { orgId: f.orgId, id: made.id });
    const venue = await objectFields(f.client, f.orgId, "venue"), company = await objectFields(f.client, f.orgId, "company");
    expect(Object.keys(venue.fields).sort()).toEqual(["capacity", "kind", "name", "owner"]);
    expect(venue.fields.kind.options.map((o: any) => o.id)).toEqual(["hall", "bar"]);
    expect(venue.fields.owner.targetObjectId).toBe(company.object._id);
    expect(venue.object.titleFieldId).toBe(venue.fields.name._id);
    const seen = (await call("GET", "/api/v1/objects")).json.find((o: any) => o.key === "venue");
    expect(seen.fields.map((x: any) => x.key)).toEqual(["name", "capacity", "kind", "owner"]);
    expect((await call("POST", "/api/v1/suggestions", { action: "create", object: "venue", values: { name: "The Hall", kind: "Hall" }, reason: "new venue" })).status).toBe(201);
  });

  it("adds options and relabels without touching anything else", async () => {
    const { f, call } = await adminAgent();
    const stage = (await objectFields(f.client, f.orgId, "opportunity")).fields.stage;
    const options = (await propose(call, { kind: "addOptions", object: "opportunity", field: "stage", options: [...stage.options, { id: "paused", label: "Paused" }] })).json.proposal;
    expect(options.summary).toBe("Add option Paused to Stage on Opportunity");
    const relabel = (await propose(call, { kind: "relabel", object: "opportunity", field: "amount", label: "Deal size" })).json.proposal;
    const object = (await propose(call, { kind: "relabel", object: "opportunity", label: "Deal", labelPlural: "Deals" })).json.proposal;
    for (const p of [options, relabel, object]) expect((await f.client.mutation(shape.apply, { orgId: f.orgId, id: p.id })).status).toBe("applied");
    const after = await objectFields(f.client, f.orgId, "opportunity");
    expect(after.fields.stage.options).toEqual([...stage.options, { id: "paused", label: "Paused" }]);
    expect(after.fields.amount.label).toBe("Deal size");
    expect([after.object.label, after.object.labelPlural, after.object.key]).toEqual(["Deal", "Deals", "opportunity"]);
  });

  it("an agent may not rename an existing option", async () => {
    const { f, call } = await adminAgent();
    const stage = (await objectFields(f.client, f.orgId, "opportunity")).fields.stage;
    const renamed = await propose(call, { kind: "addOptions", object: "opportunity", field: "stage", options: stage.options.map((o: any) => o.id === "won" ? { ...o, label: "Closed" } : o).concat({ id: "paused", label: "Paused" }) });
    expect(renamed.status).toBe(400);
    expect(await pendingRows(f)).toEqual([]);
  });

  it("fails a proposal made stale by a later change, with nothing half-applied", async () => {
    const { f, call } = await adminAgent();
    const field = (await propose(call, { kind: "addField", object: "opportunity", key: "budget", label: "Budget", type: "number" })).json.proposal;
    const object = (await propose(call, { kind: "addObject", key: "venue", label: "Venue", labelPlural: "Venues", fields: [{ key: "capacity", label: "Capacity", type: "number" }] })).json.proposal;
    const opportunity = await objectFields(f.client, f.orgId, "opportunity");
    await f.client.mutation(api.fields.create, { orgId: f.orgId, objectId: opportunity.object._id, key: "budget", label: "Budget (mine)", type: "text" });
    await f.client.mutation(api.objects.create, { orgId: f.orgId, key: "venue", label: "Venue", labelPlural: "Venues" });
    const fieldsBefore = await f.t.run((ctx: any) => ctx.db.query("fields").collect()), objectsBefore = await f.t.run((ctx: any) => ctx.db.query("objects").collect());
    expect(await f.client.mutation(shape.apply, { orgId: f.orgId, id: field.id })).toEqual({ status: "failed", error: "Field key already exists" });
    expect(await f.client.mutation(shape.apply, { orgId: f.orgId, id: object.id })).toEqual({ status: "failed", error: "Object key already exists" });
    expect(await f.t.run((ctx: any) => ctx.db.query("fields").collect())).toEqual(fieldsBefore);
    expect(await f.t.run((ctx: any) => ctx.db.query("objects").collect())).toEqual(objectsBefore);
    expect((await call("GET", "/api/v1/shape/proposals?status=failed")).json.proposals.map((p: any) => p.error).sort()).toEqual(["Field key already exists", "Object key already exists"]);
  });

  it("dismisses without changing the shape", async () => {
    const { f, call } = await adminAgent();
    const made = (await propose(call, { kind: "addField", object: "opportunity", key: "budget", label: "Budget", type: "number" })).json.proposal;
    const before = await fieldsOf(f, "opportunity");
    expect((await f.client.mutation(shape.dismiss, { orgId: f.orgId, id: made.id })).status).toBe("dismissed");
    expect(await pendingRows(f)).toEqual([]);
    expect((await f.client.mutation(shape.apply, { orgId: f.orgId, id: made.id })).status).toBe("already");
    expect(await fieldsOf(f, "opportunity")).toEqual(before);
    expect((await call("GET", "/api/v1/shape/proposals?status=dismissed")).json.proposals.map((p: any) => p.id)).toEqual([made.id]);
  });

  it("a member-role person can neither see nor apply", async () => {
    const { f, call } = await adminAgent();
    const made = (await propose(call, { kind: "addField", object: "opportunity", key: "budget", label: "Budget", type: "number" })).json.proposal;
    const member = await joined(f, "member", "member");
    await expect(member.client.mutation(shape.apply, { orgId: f.orgId, id: made.id })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
    await expect(member.client.mutation(shape.dismiss, { orgId: f.orgId, id: made.id })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
    expect(await member.client.query(shape.list, { orgId: f.orgId, status: "pending" })).toEqual([]);
    expect((await pendingRows(f)).length).toBe(1);
  });

  it("a person with restricted reads cannot apply a new object", async () => {
    const { f, call } = await adminAgent();
    const made = (await propose(call, { kind: "addObject", key: "venue", label: "Venue", labelPlural: "Venues" })).json.proposal;
    const opportunity = await objectFields(f.client, f.orgId, "opportunity"), admin = await joined(f, "scoped", "admin");
    await f.client.mutation(anyApi["authority/policies"].setMember, { orgId: f.orgId, memberId: admin.memberId, scopes: [{ objectId: opportunity.object._id, records: "all", fields: "all" }], hiddenFieldIds: [] });
    await expect(admin.client.mutation(shape.apply, { orgId: f.orgId, id: made.id })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
    expect(await admin.client.query(shape.list, { orgId: f.orgId, status: "pending" })).toEqual([]);
    expect(await f.t.run(async (ctx: any) => (await ctx.db.query("objects").collect()).some((o: any) => o.key === "venue"))).toBe(false);
  });

  it("refuses proposals and applies while the workspace is read only", async () => {
    const { f, call } = await adminAgent();
    const made = (await propose(call, { kind: "addField", object: "opportunity", key: "budget", label: "Budget", type: "number" })).json.proposal;
    await f.t.run((ctx: any) => ctx.db.patch(f.orgId, { flags: { readonly: true } }));
    expect((await propose(call, { kind: "addField", object: "opportunity", key: "size", label: "Size", type: "number" })).status).toBe(403);
    await expect(f.client.mutation(shape.apply, { orgId: f.orgId, id: made.id })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
  });
});

describe("MCP list filters", () => {
  it("segment a real REST list: people at one company", async () => {
    const f = await userAndOrg(), agent = await agentFor(f.client, f.orgId, { name: "reader" });
    const company = await objectFields(f.client, f.orgId, "company"), person = await objectFields(f.client, f.orgId, "person");
    const companies = await Promise.all(["Atlas", "Borealis"].map((name) => f.client.mutation(api.records.create, { orgId: f.orgId, objectId: company.object._id, values: { [company.fields.name._id]: name } })));
    for (const [name, at] of [["Ada", 0], ["Ben", 1], ["Cy", 0]] as const) await f.client.mutation(api.records.create, { orgId: f.orgId, objectId: person.object._id, values: { [person.fields.name._id]: name, [person.fields.company._id]: companies[at]!.recordId } });
    const client = new RemoldClient({ url: "https://remold.test", key: agent.key, fetch: (async (input: RequestInfo | URL, init?: RequestInit) => { const url = new URL(String(input)); return f.t.fetch(url.pathname + url.search, init); }) as typeof fetch });
    const atlas = await client.listRecords({ object: "person", filters: [{ field: "company", value: companies[0]!.recordId }] });
    expect(atlas.records.map((r: any) => r.title).sort()).toEqual(["Ada", "Cy"]);
    const one = await client.listRecords({ object: "person", filters: [{ field: "company", value: companies[0]!.recordId }, { field: "name", value: "Cy" }] });
    expect(one.records.map((r: any) => r.title)).toEqual(["Cy"]);
  });
});

describe("agents read their own proposals", () => {
  it("lists only the calling agent's proposals and counts them in /me", async () => {
    const { f, call } = await adminAgent("first");
    const other = rest(f.t, (await agentFor(f.client, f.orgId, { name: "second", role: "admin" })).key);
    const mine = (await propose(call, { kind: "addField", object: "opportunity", key: "budget", label: "Budget", type: "number" })).json.proposal;
    await propose(other, { kind: "addField", object: "company", key: "size", label: "Size", type: "number" });
    expect((await call("GET", "/api/v1/shape/proposals")).json.proposals.map((p: any) => p.id)).toEqual([mine.id]);
    expect((await call("GET", "/api/v1/me")).json.pendingShapeProposals).toBe(1);
    expect((await pendingRows(f)).length).toBe(2);
  });
});

const sha256 = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");
describe("shape proposal guards", () => {
  it("a proposal id from another org is not found for apply or dismiss", async () => {
    const a = await adminAgent();
    const bClient = a.f.t.withIdentity({ tokenIdentifier: "clerk|B", name: "B" }); await bClient.mutation(api.users.store, {});
    const bOrg = await bClient.mutation(api.orgs.create, { name: "B Org" });
    const bAgent = await agentFor(bClient, bOrg, { name: "bshaper", role: "admin" });
    const made = (await propose(rest(a.f.t, bAgent.key), { kind: "addField", object: "company", key: "secretly", label: "Secretly", type: "text" })).json.proposal;
    const madeObject = (await propose(rest(a.f.t, bAgent.key), { kind: "addObject", key: "venue", label: "Venue", labelPlural: "Venues" })).json.proposal;
    const tables = () => a.f.t.run(async (ctx: any) => [await ctx.db.query("fields").collect(), await ctx.db.query("objects").collect()]);
    const before = await tables();
    for (const id of [made.id, madeObject.id]) {
      await expect(a.f.client.mutation(shape.apply, { orgId: a.f.orgId, id })).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
      await expect(a.f.client.mutation(shape.dismiss, { orgId: a.f.orgId, id })).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
    }
    expect(await tables()).toEqual(before);
    expect(await a.f.client.query(shape.list, { orgId: a.f.orgId, status: "pending" })).toEqual([]);
  });

  it("a revoked agent's proposal shows paused, cannot be applied, and can be dismissed", async () => {
    const { f, agent, call } = await adminAgent();
    const made = (await propose(call, { kind: "addField", object: "opportunity", key: "budget", label: "Budget", type: "number" })).json.proposal;
    await f.client.mutation(api.agents.revoke, { orgId: f.orgId, agentId: agent.agentId });
    const rows = await f.client.query(shape.list, { orgId: f.orgId, status: "pending" });
    expect(rows.map((r: any) => r.paused)).toEqual([true]);
    await expect(f.client.mutation(shape.apply, { orgId: f.orgId, id: made.id })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
    expect((await f.client.mutation(shape.dismiss, { orgId: f.orgId, id: made.id })).status).toBe("dismissed");
  });

  it("changing an agent's grants after it proposes blocks apply", async () => {
    const { f, agent, call } = await adminAgent();
    const made = (await propose(call, { kind: "addField", object: "opportunity", key: "budget", label: "Budget", type: "number" })).json.proposal;
    await f.client.mutation(api.agents.setGrants, { orgId: f.orgId, agentId: agent.agentId, grants: [{ action: "create", objectKey: "company" }] });
    await expect(f.client.mutation(shape.apply, { orgId: f.orgId, id: made.id })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
    expect((await objectFields(f.client, f.orgId, "opportunity")).fields.budget).toBeUndefined();
  });

  it("a restricted admin agent cannot add objects, touch unreadable objects or targets, or learn hidden field keys", async () => {
    const { f, agent, call } = await adminAgent();
    const opportunity = await objectFields(f.client, f.orgId, "opportunity");
    await f.t.run((ctx: any) => ctx.db.patch(agent.agentId, { readObjectIds: [opportunity.object._id] }));
    const object = await propose(call, { kind: "addObject", key: "venue", label: "Venue", labelPlural: "Venues" });
    expect([object.status, object.json.error.code]).toEqual([403, "FORBIDDEN"]);
    const onCompany = await propose(call, { kind: "addField", object: "company", key: "size", label: "Size", type: "number" });
    expect([onCompany.status, onCompany.json.error.message]).toEqual([404, "Object not found"]);
    const unreadableTarget = await propose(call, { kind: "addField", object: "opportunity", key: "partner", label: "Partner", type: "lookup", target: "company" });
    expect([unreadableTarget.status, unreadableTarget.json.error.message]).toEqual([404, "Object not found"]);
    const nonexistentTarget = await propose(call, { kind: "addField", object: "opportunity", key: "partner", label: "Partner", type: "lookup", target: "nothere" });
    expect(nonexistentTarget.json.error.message).toBe(unreadableTarget.json.error.message);
    expect((await propose(call, { kind: "addField", object: "opportunity", key: "budget", label: "Budget", type: "number" })).status).toBe(201);
    // Hidden field on the object: a colliding key must not reveal it exists.
    await f.t.run((ctx: any) => ctx.db.patch(agent.agentId, { hiddenFieldIds: [opportunity.fields.amount._id] }));
    const collide = await propose(call, { kind: "addField", object: "opportunity", key: "amount", label: "Amount", type: "number" });
    expect(collide.status).toBe(403);
    expect(collide.json.error.message).not.toMatch(/exists/);
    expect((await propose(call, { kind: "relabel", object: "opportunity", field: "amount", label: "X" })).status).toBeGreaterThanOrEqual(400);
    expect((await f.client.query(shape.list, { orgId: f.orgId, status: "pending" })).length).toBe(1);
  });

  it("unknown kinds, bad status and blank labels are clean 400s that store nothing", async () => {
    const { f, call } = await adminAgent();
    const unknown = await propose(call, { kind: "deleteObject", object: "company" });
    expect([unknown.status, unknown.json.error.code]).toEqual([400, "VALIDATION"]);
    const bogus = await call("GET", "/api/v1/shape/proposals?status=bogus");
    expect(bogus.status).toBe(400);
    const textWithOptions = await propose(call, { kind: "addField", object: "opportunity", key: "x", label: "X", type: "text", options: [{ id: "a", label: "A" }] });
    expect([textWithOptions.status, textWithOptions.json.error.message]).toEqual([400, "Only select fields have options"]);
    const thirteen = await propose(call, { kind: "addObject", key: "venue", label: "Venue", labelPlural: "Venues", fields: Array.from({ length: 13 }, (_, i) => ({ key: `f${i}`, label: `F${i}`, type: "text" })) });
    expect(thirteen.status).toBe(400);
    const emptyLabel = await propose(call, { kind: "relabel", object: "opportunity", label: "  " });
    expect([emptyLabel.status, emptyLabel.json.error.message]).toEqual([400, "Label is required"]);
    expect(await f.client.query(shape.list, { orgId: f.orgId, status: "pending" })).toEqual([]);
    // Human path shares the new label rule (disclosed change).
    await expect(f.client.mutation(api.objects.create, { orgId: f.orgId, key: "venue", label: "", labelPlural: "Venues" })).rejects.toMatchObject({ data: { message: "Label is required" } });
  });

  it("a body keyHash cannot redirect a proposal to another agent or org", async () => {
    const a = await adminAgent();
    const bClient = a.f.t.withIdentity({ tokenIdentifier: "clerk|B", name: "B" }); await bClient.mutation(api.users.store, {});
    const bOrg = await bClient.mutation(api.orgs.create, { name: "B Org" });
    const bAgent = await agentFor(bClient, bOrg, { name: "bshaper", role: "admin" });
    const forged = await a.call("POST", "/api/v1/shape/proposals", { kind: "addField", object: "company", key: "size", label: "Size", type: "number", reason: "x", keyHash: await sha256(bAgent.key) });
    expect(forged.status).toBe(201);
    expect((await bClient.query(shape.list, { orgId: bOrg, status: "pending" })).length).toBe(0);
    expect((await a.f.client.query(shape.list, { orgId: a.f.orgId, status: "pending" })).map((r: any) => r.agentName)).toEqual(["shaper"]);
    // Extra fields that are not arguments are refused, not stored.
    const smuggled = await a.call("POST", "/api/v1/shape/proposals", { kind: "addField", object: "company", key: "big", label: "Big", type: "number", reason: "x", status: "applied" });
    expect(smuggled.status).toBe(400);
  });

  it("addOptions with the existing options in another key order is accepted", async () => {
    const { f, call } = await adminAgent();
    const stage = (await objectFields(f.client, f.orgId, "opportunity")).fields.stage;
    const reordered = stage.options.map((o: any) => ({ label: o.label, id: o.id }));
    const r = await propose(call, { kind: "addOptions", object: "opportunity", field: "stage", options: [...reordered, { id: "paused", label: "Paused" }] });
    expect([r.status, r.json.error?.message]).toEqual([201, undefined]);
  });

  it("a ninth number field applies unindexed; a lookup with no slot left is refused up front", async () => {
    const { f, call } = await adminAgent();
    const made = (await propose(call, { kind: "addObject", key: "venue", label: "Venue", labelPlural: "Venues", fields: Array.from({ length: 9 }, (_, i) => ({ key: `n${i}`, label: `N${i}`, type: "number" })) })).json.proposal;
    expect((await f.client.mutation(shape.apply, { orgId: f.orgId, id: made.id })).status).toBe("applied");
    const venue = await objectFields(f.client, f.orgId, "venue");
    expect(Object.values(venue.fields).filter((x: any) => x.type === "number" && !x.slot).length).toBe(1);
    // A lookup proposed as the 9th s-slot user is refused up front.
    const tooMany = await propose(call, { kind: "addObject", key: "hall", label: "Hall", labelPlural: "Halls", fields: [...Array.from({ length: 7 }, (_, i) => ({ key: `t${i}`, label: `T${i}`, type: "text" })), { key: "owner", label: "Owner", type: "lookup", target: "company" }] });
    expect([tooMany.status, tooMany.json.error.code]).toEqual([409, "SLOTS_EXHAUSTED"]);
  });

  it("a scoped admin sees and applies only proposals about objects and lookup targets in scope", async () => {
    const { f, call } = await adminAgent();
    await propose(call, { kind: "addField", object: "opportunity", key: "budget", label: "Budget", type: "number" });
    await propose(call, { kind: "addField", object: "opportunity", key: "partner", label: "Partner", type: "lookup", target: "company" });
    await propose(call, { kind: "addField", object: "company", key: "size", label: "Size", type: "number" });
    await propose(call, { kind: "relabel", object: "company", label: "Account", labelPlural: "Accounts" });
    const opportunity = await objectFields(f.client, f.orgId, "opportunity"), admin = await joined(f, "scoped", "admin");
    await f.client.mutation(anyApi["authority/policies"].setMember, { orgId: f.orgId, memberId: admin.memberId, scopes: [{ objectId: opportunity.object._id, records: "all", fields: "all" }], hiddenFieldIds: [] });
    const seen = await admin.client.query(shape.list, { orgId: f.orgId, status: "pending" });
    expect(seen.map((r: any) => r.summary)).toEqual(["Add field Budget (number) to Opportunity"]);
    const all = await f.client.query(shape.list, { orgId: f.orgId, status: "pending" });
    const partner = all.find((r: any) => r.summary.includes("Partner")), size = all.find((r: any) => r.summary.includes("Size"));
    await expect(admin.client.mutation(shape.apply, { orgId: f.orgId, id: partner._id })).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
    await expect(admin.client.mutation(shape.apply, { orgId: f.orgId, id: size._id })).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
    expect(all.length).toBe(4);
  });

  it("the agent list honours ?status= and /me counts only pending", async () => {
    const { f, call } = await adminAgent();
    const a = (await propose(call, { kind: "addField", object: "opportunity", key: "budget", label: "Budget", type: "number" })).json.proposal;
    await propose(call, { kind: "addField", object: "opportunity", key: "size", label: "Size", type: "number" });
    await f.client.mutation(shape.apply, { orgId: f.orgId, id: a.id });
    expect((await call("GET", "/api/v1/shape/proposals?status=pending")).json.proposals.map((p: any) => p.status)).toEqual(["pending"]);
    expect((await call("GET", "/api/v1/shape/proposals?status=applied")).json.proposals.map((p: any) => p.status)).toEqual(["applied"]);
    expect((await call("GET", "/api/v1/shape/proposals")).json.proposals.length).toBe(2);
    expect((await call("GET", "/api/v1/me")).json.pendingShapeProposals).toBe(1);
  });

  it("applying addObject extends only the proposer's read list, by exactly the new object", async () => {
    const { f, agent, call } = await adminAgent("first");
    const second = await agentFor(f.client, f.orgId, { name: "second", role: "admin" });
    const made = (await propose(call, { kind: "addObject", key: "venue", label: "Venue", labelPlural: "Venues" })).json.proposal;
    const before: any = await f.t.run((ctx: any) => ctx.db.get(agent.agentId));
    await f.client.mutation(shape.apply, { orgId: f.orgId, id: made.id });
    const after: any = await f.t.run((ctx: any) => ctx.db.get(agent.agentId)), venue = await objectFields(f.client, f.orgId, "venue");
    expect(after.readObjectIds).toEqual([...before.readObjectIds, venue.object._id]);
    expect([after.grants, after.authorityEpoch, after.hiddenFieldIds]).toEqual([before.grants, before.authorityEpoch, before.hiddenFieldIds]);
    const other: any = await f.t.run((ctx: any) => ctx.db.get(second.agentId));
    expect(other.readObjectIds).not.toContain(venue.object._id);
    const audit: any[] = await f.t.run((ctx: any) => ctx.db.query("authorityAudit").collect());
    expect(audit.map((row: any) => row.action).filter((action: string) => /^(agentReadExtended|shapeProposalApplied)$/.test(action)).sort()).toEqual(["agentReadExtended", "shapeProposalApplied"]);
  });
});
