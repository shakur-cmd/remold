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
    return { personError, agentError: agentReply.json.error.message };
  }
  it("bad key", async () => {
    const r = await both((f, { opportunity }) => f.client.mutation(api.fields.create, { orgId: f.orgId, objectId: opportunity.object._id, key: "Bad key", label: "Bad", type: "text" }), () => ({ kind: "addField", object: "opportunity", key: "Bad key", label: "Bad", type: "text" }));
    expect(r).toEqual({ personError: "Invalid field key", agentError: "Invalid field key" });
    const o = await both((f) => f.client.mutation(api.objects.create, { orgId: f.orgId, key: "9lives", label: "Cat", labelPlural: "Cats" }), () => ({ kind: "addObject", key: "9lives", label: "Cat", labelPlural: "Cats" }));
    expect(o).toEqual({ personError: "Invalid object key", agentError: "Invalid object key" });
  });
  it("duplicate key", async () => {
    const r = await both((f, { opportunity }) => f.client.mutation(api.fields.create, { orgId: f.orgId, objectId: opportunity.object._id, key: "amount", label: "Again", type: "number" }), () => ({ kind: "addField", object: "opportunity", key: "amount", label: "Again", type: "number" }));
    expect(r).toEqual({ personError: "Field key already exists", agentError: "Field key already exists" });
    const o = await both((f) => f.client.mutation(api.objects.create, { orgId: f.orgId, key: "company", label: "Company", labelPlural: "Companies" }), () => ({ kind: "addObject", key: "company", label: "Company", labelPlural: "Companies" }));
    expect(o).toEqual({ personError: "Object key already exists", agentError: "Object key already exists" });
  });
  it("select without options", async () => {
    const r = await both((f, { opportunity }) => f.client.mutation(api.fields.create, { orgId: f.orgId, objectId: opportunity.object._id, key: "tier", label: "Tier", type: "select" }), () => ({ kind: "addField", object: "opportunity", key: "tier", label: "Tier", type: "select" }));
    expect(r).toEqual({ personError: "Select needs unique options", agentError: "Select needs unique options" });
  });
  it("withTime on a field that is not a date", async () => {
    const r = await both((f, { opportunity }) => f.client.mutation(api.fields.create, { orgId: f.orgId, objectId: opportunity.object._id, key: "score", label: "Score", type: "number", withTime: true }), () => ({ kind: "addField", object: "opportunity", key: "score", label: "Score", type: "number", withTime: true }));
    expect(r).toEqual({ personError: "Only date fields keep time", agentError: "Only date fields keep time" });
  });
  it("a relation to an object the proposer cannot read", async () => {
    // The agent exists before Vault, so it cannot read Vault; the person is scoped to Opportunity only.
    let vault: any;
    const r = await both((f, { opportunity }) => f.client.mutation(api.fields.create, { orgId: f.orgId, objectId: opportunity.object._id, key: "vault", label: "Vault", type: "lookup", targetObjectId: vault }), () => ({ kind: "addField", object: "opportunity", key: "vault", label: "Vault", type: "lookup", target: "vault" }), async (f) => {
      vault = await f.client.mutation(api.objects.create, { orgId: f.orgId, key: "vault", label: "Vault", labelPlural: "Vaults" });
      const opportunity = await objectFields(f.client, f.orgId, "opportunity"), memberId = await f.t.run(async (ctx: any) => (await ctx.db.query("members").collect())[0]._id);
      await f.client.mutation(anyApi["authority/policies"].setMember, { orgId: f.orgId, memberId, scopes: [{ objectId: opportunity.object._id, records: "all", fields: "all" }], hiddenFieldIds: [] });
    });
    expect(r).toEqual({ personError: "Object not found", agentError: "Object not found" });
  });
  it("removing an existing option", async () => {
    const r = await both((f, { opportunity }) => f.client.mutation(api.fields.update, { orgId: f.orgId, fieldId: opportunity.fields.stage._id, options: [{ id: "won", label: "Won" }] }), () => ({ kind: "addOptions", object: "opportunity", field: "stage", options: [{ id: "won", label: "Won" }] }));
    expect(r).toEqual({ personError: "Options cannot be removed", agentError: "Options cannot be removed" });
  });
  it("a lookup with no index slot left", async () => {
    const r = await both((f, { opportunity }) => f.client.mutation(api.fields.create, { orgId: f.orgId, objectId: opportunity.object._id, key: "partner", label: "Partner", type: "lookup", targetObjectId: opportunity.fields.company.targetObjectId }), () => ({ kind: "addField", object: "opportunity", key: "partner", label: "Partner", type: "lookup", target: "company" }), async (f) => {
      const opportunity = await objectFields(f.client, f.orgId, "opportunity");
      for (let i = 0; i < 8; i++) await f.client.mutation(api.fields.create, { orgId: f.orgId, objectId: opportunity.object._id, key: `note${i}`, label: `Note ${i}`, type: "text" });
    });
    expect(r.agentError).toBe(r.personError);
    expect(r.personError).toMatch(/slot/i);
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
