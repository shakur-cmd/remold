import { describe, expect, it } from "vitest";
import { anyApi } from "convex/server";
import { agentFor, api, objectFields, rest, userAndOrg } from "./test.helpers";
import { RemoldClient } from "../packages/mcp/src/client";

const shape = anyApi.shapeSuggestions, blueprints = anyApi.blueprints;
type F = Awaited<ReturnType<typeof userAndOrg>>;
const propose = (call: ReturnType<typeof rest>, blueprint: unknown) => call("POST", "/api/v1/shape/proposals", { kind: "blueprint", reason: "the shop repairs things", blueprint });
async function adminAgent(name = "shaper") { const f = await userAndOrg(); const agent = await agentFor(f.client, f.orgId, { name, role: "admin" }); return { f, agent, call: rest(f.t, agent.key) }; }
const counts = (f: F) => f.t.run(async (ctx: any) => ({ objects: (await ctx.db.query("objects").collect()).length, fields: (await ctx.db.query("fields").collect()).length, records: (await ctx.db.query("records").collect()).length }));
const pending = (f: F) => f.client.query(shape.list, { orgId: f.orgId, status: "pending" });
async function joined(f: F, name: string, role: "admin" | "member") {
  const { token } = await f.client.mutation(api.invites.create, { orgId: f.orgId, role });
  const client = f.t.withIdentity({ tokenIdentifier: `clerk|${name}`, name }); await client.mutation(api.users.store, {}); await client.mutation(api.invites.accept, { token });
  return client;
}
// Everything a person sees of a workspace's shape, by key, in order: what an export must reproduce.
const shapeOf = (f: F) => f.t.run(async (ctx: any) => {
  const objects = (await ctx.db.query("objects").withIndex("by_org", (q: any) => q.eq("orgId", f.orgId)).collect()).sort((a: any, b: any) => a.order - b.order);
  const keyOf = new Map(objects.map((o: any) => [o._id, o.key]));
  return Promise.all(objects.map(async (o: any) => {
    const fields = (await ctx.db.query("fields").withIndex("by_object", (q: any) => q.eq("orgId", f.orgId).eq("objectId", o._id)).collect()).sort((a: any, b: any) => a.order - b.order);
    return { key: o.key, label: o.label, labelPlural: o.labelPlural, archived: !!o.archived, title: fields.find((x: any) => x._id === o.titleFieldId)?.key, fields: fields.filter((x: any) => !x.retired).map((x: any) => ({ key: x.key, label: x.label, type: x.type, options: x.options ?? null, target: x.targetObjectId ? keyOf.get(x.targetObjectId) : null, required: x.required, withTime: !!x.withTime, indexed: !!x.slot })), retired: fields.filter((x: any) => x.retired).map((x: any) => x.key) };
  }));
});

// A repair shop: Job and Quote point at each other, and Job is declared before Quote exists.
const repair = {
  version: 1, name: "Repair shop", description: "Jobs and quotes for a repair shop",
  changes: [
    { kind: "addObject", key: "repairJob", label: "Repair Job", labelPlural: "Repair Jobs", fields: [
      { key: "customer", label: "Customer", type: "lookup", target: "person" },
      { key: "quote", label: "Quote", type: "lookup", target: "quote" },
      { key: "status", label: "Status", type: "select", options: [{ id: "new", label: "New" }, { id: "diagnosed", label: "Diagnosed" }, { id: "done", label: "Done" }] },
      { key: "price", label: "Price", type: "number" },
    ] },
    { kind: "addObject", key: "quote", label: "Quote", labelPlural: "Quotes", fields: [{ key: "amount", label: "Amount", type: "number" }, { key: "job", label: "Job", type: "lookup", target: "repairJob" }] },
    { kind: "addField", object: "repairJob", key: "notes", label: "Notes", type: "text", indexed: false },
    { kind: "addOptions", object: "opportunity", field: "stage", options: [{ id: "diagnosed", label: "Diagnosed" }, { id: "partsOrdered", label: "Parts ordered" }] },
  ],
  records: [
    { object: "quote", values: { name: "Tap repair quote", amount: 120 } },
    { object: "repairJob", values: { name: "Tap repair", quote: "Tap repair quote", status: "New", price: 120 } },
  ],
};

describe("blueprints apply as one reviewed proposal", () => {
  it("applies a blueprint whose new objects refer to each other, shown as one grouped card", async () => {
    const { f, agent, call } = await adminAgent();
    const before = await counts(f);
    const made = await propose(call, repair);
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    expect(made.json.proposal).toMatchObject({ kind: "blueprint", status: "pending", summary: "Apply blueprint Repair shop: 2 new objects, 2 other changes" });
    expect(await counts(f)).toEqual(before);
    const [card] = await pending(f);
    expect(card.blueprint.groups.map((g: any) => g.title)).toEqual(["New object Repair Job with 5 fields", "New object Quote with 2 fields", "Opportunity"]);
    expect(card.blueprint.groups[2].lines).toEqual(["Stage gains: Diagnosed, Parts ordered"]);
    expect(card.blueprint.records).toBe("2 starter records: 1 Quote, 1 Repair Job");
    const checked = await f.client.action(blueprints.check, { orgId: f.orgId, id: card._id });
    expect(checked.ok).toBe(true);
    expect(checked.slots.find((s: any) => s.object === "Repair Job")).toEqual({ object: "Repair Job", text: "4 of 8", number: "1 of 8", date: "0 of 4", boolean: "0 of 4" });
    expect(await counts(f)).toEqual(before);

    expect(await f.client.action(shape.applyBlueprint, { orgId: f.orgId, id: card._id, withRecords: false })).toMatchObject({ status: "applied" });
    const job = await objectFields(f.client, f.orgId, "repairJob"), quote = await objectFields(f.client, f.orgId, "quote");
    expect(Object.keys(job.fields)).toEqual(["name", "customer", "quote", "status", "price", "notes"]);
    expect(job.fields.quote.targetObjectId).toBe(quote.object._id);
    expect(quote.fields.job.targetObjectId).toBe(job.object._id);
    expect(job.fields.notes.slot).toBeUndefined();
    expect((await objectFields(f.client, f.orgId, "opportunity")).fields.stage.options.slice(-2).map((o: any) => o.label)).toEqual(["Diagnosed", "Parts ordered"]);
    expect((await counts(f)).records).toBe(0);
    // The proposer can work in what it asked for.
    const agentRow: any = await f.t.run((ctx: any) => ctx.db.get(agent.agentId));
    if (agentRow.authorityVersion === 1) expect(agentRow.readObjectIds).toEqual(expect.arrayContaining([job.object._id, quote.object._id]));
    expect((await call("GET", "/api/v1/objects")).json.map((o: any) => o.key)).toEqual(expect.arrayContaining(["repairJob", "quote"]));
    expect((await call("GET", "/api/v1/shape/proposals?status=applied")).json.proposals[0]).toMatchObject({ kind: "blueprint", status: "applied" });
    expect(await f.client.action(shape.applyBlueprint, { orgId: f.orgId, id: card._id, withRecords: true })).toMatchObject({ status: "already" });
    expect((await counts(f)).records).toBe(0);
  });

  it("creates starter records only when the person ticks the box, linked and attributed to them", async () => {
    const { f, call } = await adminAgent();
    await propose(call, repair);
    const [card] = await pending(f);
    await f.client.action(shape.applyBlueprint, { orgId: f.orgId, id: card._id, withRecords: true });
    const user = await f.client.query(api.users.me, {});
    const rows: any[] = await f.t.run((ctx: any) => ctx.db.query("records").collect());
    expect(rows.map((r) => r.title).sort()).toEqual(["Tap repair", "Tap repair quote"]);
    const job = await objectFields(f.client, f.orgId, "repairJob"), quoteRow = rows.find((r) => r.title === "Tap repair quote"), jobRow = rows.find((r) => r.title === "Tap repair");
    expect(jobRow.values[job.fields.quote._id]).toBe(quoteRow._id);
    expect(rows.every((r) => r.createdBy === user!._id)).toBe(true);
    const events: any[] = await f.t.run((ctx: any) => ctx.db.query("events").collect());
    expect(events.filter((e) => e.recordId === jobRow._id).map((e) => e.actor)).toEqual([{ kind: "user", id: user!._id }]);
  });

  it("a person picks a built-in template, checks it and applies it, records only when asked", async () => {
    const f = await userAndOrg();
    const templates = await f.client.query(blueprints.templates, {});
    expect(templates.map((t: any) => t.id)).toEqual(["service", "agency", "creator", "retail"]);
    const service = templates[0].blueprint;
    const preview = await f.client.query(blueprints.preview, { orgId: f.orgId, blueprint: service });
    expect(preview.groups.length).toBeGreaterThan(1);
    expect((await f.client.action(blueprints.check, { orgId: f.orgId, blueprint: service })).ok).toBe(true);
    await f.client.mutation(blueprints.apply, { orgId: f.orgId, blueprint: service, withRecords: false });
    expect((await counts(f)).records).toBe(0);
    const audit: any[] = await f.t.run((ctx: any) => ctx.db.query("authorityAudit").collect());
    expect(audit.some((row) => row.action === "blueprintApplied")).toBe(true);
  });
});

describe("blueprint validation names the problem and stores nothing", () => {
  const nine = (prefix: string) => Array.from({ length: 9 }, (_, i) => ({ key: `${prefix}${i}`, label: `${prefix} ${i}`, type: "text" }));
  async function refused(blueprint: unknown) {
    const { f, call } = await adminAgent();
    const before = await counts(f), reply = await propose(call, blueprint);
    expect(reply.status).toBeGreaterThanOrEqual(400);
    expect(await pending(f)).toEqual([]);
    expect(await counts(f)).toEqual(before);
    return reply.json.error;
  }
  it("slot exhaustion summed across every change in the blueprint", async () => {
    // 1 (Name) + 6 + 3 text fields on one new object: more than its 8 text slots, though each change alone fits.
    const error = await refused({ version: 1, name: "Too wide", description: "", changes: [
      { kind: "addObject", key: "wide", label: "Wide", labelPlural: "Wides", fields: nine("a").slice(0, 6) },
      { kind: "addField", object: "wide", key: "b0", label: "B0", type: "text" }, { kind: "addField", object: "wide", key: "b1", label: "B1", type: "text" }, { kind: "addField", object: "wide", key: "b2", label: "B2", type: "text" },
    ] });
    expect(error).toMatchObject({ code: "SLOTS_EXHAUSTED", message: "Not enough index slots on Wide: it needs 10 text slots and has 8. Set indexed: false on text fields nobody sorts or filters by." });
    // On an existing object, counted against the slots it already uses.
    const existing = await refused({ version: 1, name: "Busy deals", description: "", changes: [{ kind: "addField", object: "opportunity", key: "x1", label: "X1", type: "date" }, { kind: "addField", object: "opportunity", key: "x2", label: "X2", type: "date" }, { kind: "addField", object: "opportunity", key: "x3", label: "X3", type: "date" }, { kind: "addField", object: "opportunity", key: "x4", label: "X4", type: "date" }] });
    expect(existing.message).toMatch(/^Not enough index slots on Opportunity: it needs \d+ date slots and has 4\./);
    const lookups = await refused({ version: 1, name: "Many links", description: "", changes: [{ kind: "addObject", key: "hub", label: "Hub", labelPlural: "Hubs", fields: Array.from({ length: 8 }, (_, i) => ({ key: `l${i}`, label: `L${i}`, type: "lookup", target: "company" })) }] });
    expect(lookups).toMatchObject({ code: "SLOTS_EXHAUSTED", message: "Step 1, add object hub: L7: No index slot left for another lookup on this object" });
  });
  it("key collisions, with the workspace and within the blueprint", async () => {
    expect((await refused({ version: 1, name: "x", description: "", changes: [{ kind: "addObject", key: "company", label: "Firm", labelPlural: "Firms" }] })).message).toBe("Step 1, add object company: Object key already exists");
    expect((await refused({ version: 1, name: "x", description: "", changes: [{ kind: "addObject", key: "van", label: "Van", labelPlural: "Vans" }, { kind: "addObject", key: "van", label: "Van", labelPlural: "Vans" }] })).message).toBe("Step 2, add object van: Object key already exists");
    expect((await refused({ version: 1, name: "x", description: "", changes: [{ kind: "addField", object: "company", key: "size", label: "Size", type: "number" }, { kind: "addField", object: "company", key: "size", label: "Size", type: "text" }] })).message).toBe("Step 2, add field company.size: Field key already exists");
  });
  it("dangling references, to objects, fields and records", async () => {
    expect((await refused({ version: 1, name: "x", description: "", changes: [{ kind: "addObject", key: "van", label: "Van", labelPlural: "Vans", fields: [{ key: "depot", label: "Depot", type: "lookup", target: "depot" }] }] })).message).toBe('Step 1 refers to object "depot", which is not in this workspace or this blueprint');
    expect((await refused({ version: 1, name: "x", description: "", changes: [{ kind: "addOptions", object: "opportunity", field: "phase", options: [{ id: "a", label: "A" }] }] })).message).toBe("Step 1, add options opportunity.phase: Field not found");
    expect((await refused({ ...repair, records: [{ object: "lorry", values: { name: "x" } }] })).message).toBe('Starter record 1 refers to object "lorry", which is not in this workspace or this blueprint');
    expect((await refused({ ...repair, records: [{ object: "repairJob", values: { name: "x", quote: "No such quote" } }] })).message).toMatch(/^Starter record 1 \(Repair Job x\): /);
  });
  it("format: version, kinds, size limits", async () => {
    expect((await refused({ ...repair, version: 2 })).message).toBe("Unsupported blueprint version; use 1");
    expect((await refused({ ...repair, changes: [{ kind: "restoreField", object: "company", field: "city" }] })).message).toMatch(/^Step 1: kind must be one of addObject, addField/);
    expect((await refused({ ...repair, records: Array.from({ length: 51 }, (_, i) => ({ object: "quote", values: { name: `q${i}` } })) })).message).toBe("A blueprint can carry at most 50 starter records");
    expect((await refused({ ...repair, changes: Array.from({ length: 101 }, (_, i) => ({ kind: "addField", object: "company", key: `f${i}`, label: `F${i}`, type: "text", indexed: false })) })).message).toBe("A blueprint can have at most 100 changes");
  });
});

describe("blueprint apply is all or nothing", () => {
  it("a blueprint made stale before apply fails plainly and leaves nothing half applied", async () => {
    const { f, call } = await adminAgent();
    await propose(call, repair);
    const [card] = await pending(f);
    // Step 3 (Repair Job notes) still applies; step 4 no longer does, after steps 1 and 2 would have created objects.
    const stage = (await objectFields(f.client, f.orgId, "opportunity")).fields.stage;
    await f.client.mutation(api.fields.update, { orgId: f.orgId, fieldId: stage._id, options: [...stage.options, { id: "diagnosed", label: "Looked at" }] });
    const before = await shapeOf(f), countsBefore = await counts(f);
    const result = await f.client.action(shape.applyBlueprint, { orgId: f.orgId, id: card._id, withRecords: true });
    expect(result).toEqual({ status: "failed", error: "Step 4, add options opportunity.stage: Agents can add options but not change existing ones" });
    expect(await shapeOf(f)).toEqual(before);
    expect(await counts(f)).toEqual(countsBefore);
    expect((await f.client.query(shape.list, { orgId: f.orgId, status: "failed" }))[0]).toMatchObject({ kind: "blueprint", error: result.error });
    expect((await call("GET", "/api/v1/shape/proposals?status=failed")).json.proposals[0].error).toBe(result.error);
  });
  it("a person's direct apply of an invalid blueprint changes nothing", async () => {
    const f = await userAndOrg(), before = await shapeOf(f);
    const bad = { ...repair, changes: [...repair.changes, { kind: "addField", object: "quote", key: "amount", label: "Again", type: "number" }] };
    const check = await f.client.action(blueprints.check, { orgId: f.orgId, blueprint: bad });
    expect(check).toEqual({ ok: false, error: "Step 5, add field quote.amount: Field key already exists" });
    await expect(f.client.mutation(blueprints.apply, { orgId: f.orgId, blueprint: bad, withRecords: true })).rejects.toThrow(/Field key already exists/);
    expect(await shapeOf(f)).toEqual(before);
  });
});

describe("blueprint export", () => {
  it("exporting a reshaped workspace and applying it to a new one reproduces the shape", async () => {
    const { f, call } = await adminAgent();
    const templates = (await call("GET", "/api/v1/blueprints")).json.blueprints;
    await f.client.mutation(blueprints.apply, { orgId: f.orgId, blueprint: templates.find((t: any) => t.id === "service").blueprint, withRecords: false });
    // A person's own edits on top: relabel, retire, custom option, reorder fields, options and objects, retitle, archive.
    const stage = (await objectFields(f.client, f.orgId, "opportunity")).fields.stage;
    await f.client.mutation(blueprints.apply, { orgId: f.orgId, withRecords: false, blueprint: { version: 1, name: "edits", description: "", changes: [
      { kind: "relabel", object: "company", label: "Client", labelPlural: "Clients" },
      { kind: "relabel", object: "company", field: "domain", label: "Website" },
      { kind: "retireField", object: "company", field: "city" },
      { kind: "addOptions", object: "opportunity", field: "stage", options: [{ id: "onHold", label: "On hold", color: "amber" }] },
      { kind: "reorderOptions", object: "opportunity", field: "stage", order: ["onHold", ...stage.options.map((o: any) => o.id)] },
      { kind: "reorderFields", object: "quote", order: ["amount", "customer", "name", "status", "sentOn", "validUntil", "details"] },
      { kind: "addField", object: "quote", key: "reference", label: "Reference", type: "text", required: true },
      { kind: "setTitleField", object: "quote", field: "reference" },
      { kind: "relabel", object: "job", field: "name", label: "Job title" },
      { kind: "archiveObject", object: "visit" },
      { kind: "addField", object: "company", key: "legacy", label: "Legacy code", type: "text" },
      { kind: "retireField", object: "company", field: "legacy" },
      { kind: "retireField", object: "job", field: "address" },
    ] } });
    const order = (await shapeOf(f)).filter((o: any) => !o.archived).map((o: any) => o.key);
    await f.client.mutation(blueprints.apply, { orgId: f.orgId, withRecords: false, blueprint: { version: 1, name: "order", description: "", changes: [{ kind: "reorderObjects", order: [order.at(-1), ...order.slice(0, -1)] }] } });
    const source = await shapeOf(f);

    const exported = await f.client.query(blueprints.current, { orgId: f.orgId });
    expect(exported).toMatchObject({ version: 1 });
    expect(JSON.stringify(exported)).not.toMatch(/"_id"|keyHash|records/);
    // The agent was made before the template's objects, so its export is the same minus what it cannot read.
    const agents = (await call("GET", "/api/v1/blueprints/current")).json.blueprint;
    expect(agents.changes).toEqual(exported.changes.filter((c: any) => !["job", "quote", "visit"].includes(c.object ?? c.key) && c.target !== "job" && c.kind !== "reorderObjects"));
    const g = await userAndOrg("B");
    expect(await g.client.action(blueprints.check, { orgId: g.orgId, blueprint: exported })).toMatchObject({ ok: true });
    await g.client.mutation(blueprints.apply, { orgId: g.orgId, blueprint: exported, withRecords: false });
    expect(await shapeOf(g)).toEqual(source);
  });

  it("a blueprint can change several titles at once, as an export of such a workspace does", async () => {
    const f = await userAndOrg(), before = await shapeOf(f);
    await f.client.mutation(blueprints.apply, { orgId: f.orgId, withRecords: false, blueprint: { version: 1, name: "titles", description: "", changes: [{ kind: "setTitleField", object: "company", field: "domain" }, { kind: "setTitleField", object: "person", field: "email" }] } });
    const after = await shapeOf(f);
    expect([after.find((o: any) => o.key === "company").title, after.find((o: any) => o.key === "person").title]).toEqual(["domain", "email"]);
    expect(before.find((o: any) => o.key === "company").title).toBe("name");
  });

  it("an untouched workspace exports an empty blueprint", async () => {
    const f = await userAndOrg();
    expect((await f.client.query(blueprints.current, { orgId: f.orgId })).changes).toEqual([]);
  });

  it("export leaves out objects and fields the caller cannot read", async () => {
    const { f, agent, call } = await adminAgent();
    await f.client.mutation(blueprints.apply, { orgId: f.orgId, blueprint: repair, withRecords: false });
    await f.client.mutation(blueprints.apply, { orgId: f.orgId, withRecords: false, blueprint: { version: 1, name: "secret", description: "", changes: [{ kind: "addField", object: "opportunity", key: "margin", label: "Margin", type: "number" }, { kind: "addField", object: "opportunity", key: "partner", label: "Partner", type: "lookup", target: "quote" }, { kind: "addField", object: "opportunity", key: "visible", label: "Visible", type: "number" }] } });
    const opportunity = await objectFields(f.client, f.orgId, "opportunity");
    await f.t.run((ctx: any) => ctx.db.patch(agent.agentId, { authorityVersion: 1, readObjectIds: [opportunity.object._id], hiddenFieldIds: [opportunity.fields.margin._id] }));
    const text = JSON.stringify((await call("GET", "/api/v1/blueprints/current")).json.blueprint);
    expect(text).toMatch(/"visible"/);
    for (const hidden of ["repairJob", "quote", "margin", "partner", "Repair Job"]) expect(text).not.toContain(`"${hidden}"`);
    // A person scoped to Opportunity, with Margin hidden, sees the same.
    const scoped = await joined(f, "Scoped", "admin");
    const memberId = await f.t.run(async (ctx: any) => (await ctx.db.query("members").collect()).find((m: any) => m.role === "admin")._id);
    await f.client.mutation(anyApi["authority/policies"].setMember, { orgId: f.orgId, memberId, scopes: [{ objectId: opportunity.object._id, records: "all", fields: "all" }], hiddenFieldIds: [opportunity.fields.margin._id] });
    const theirs = JSON.stringify(await scoped.query(blueprints.current, { orgId: f.orgId }));
    expect(theirs).toMatch(/"visible"/);
    for (const hidden of ["repairJob", "quote", "margin", "partner"]) expect(theirs).not.toContain(`"${hidden}"`);
  });
});

describe("built-in blueprints", () => {
  it("each validates and applies, with its starter records, to a fresh workspace, and agents can list them", async () => {
    const { call } = await adminAgent();
    const listed = (await call("GET", "/api/v1/blueprints")).json.blueprints;
    expect(listed.map((t: any) => [t.id, t.blueprint.version])).toEqual([["service", 1], ["agency", 1], ["creator", 1], ["retail", 1]]);
    for (const { id, blueprint } of listed) {
      const fresh = await adminAgent();
      expect((await propose(fresh.call, blueprint)).status, id).toBe(201);
      const [card] = await pending(fresh.f);
      expect(await fresh.f.client.action(blueprints.check, { orgId: fresh.f.orgId, id: card._id, withRecords: true }), id).toMatchObject({ ok: true });
      expect(await fresh.f.client.action(shape.applyBlueprint, { orgId: fresh.f.orgId, id: card._id, withRecords: true }), id).toMatchObject({ status: "applied" });
      const keys = (await shapeOf(fresh.f)).map((o: any) => o.key);
      for (const change of blueprint.changes) if (change.kind === "addObject") expect(keys, id).toContain(change.key);
      expect((await counts(fresh.f)).records, id).toBe(blueprint.records?.length ?? 0);
    }
  }, 60_000);
});

describe("blueprints need an admin", () => {
  it("member-role agents and people are refused", async () => {
    const f = await userAndOrg(), helper = await agentFor(f.client, f.orgId, { name: "helper" });
    const reply = await propose(rest(f.t, helper.key), repair);
    expect([reply.status, reply.json.error.code]).toEqual([403, "FORBIDDEN"]);
    const admin = await agentFor(f.client, f.orgId, { name: "shaper", role: "admin" });
    await propose(rest(f.t, admin.key), repair);
    const [card] = await pending(f);
    const member = await joined(f, "Member", "member");
    expect(await member.query(shape.list, { orgId: f.orgId, status: "pending" })).toEqual([]);
    await expect(member.action(shape.applyBlueprint, { orgId: f.orgId, id: card._id, withRecords: false })).rejects.toThrow(/FORBIDDEN|role|admin/i);
    await expect(member.mutation(blueprints.apply, { orgId: f.orgId, blueprint: repair, withRecords: false })).rejects.toThrow();
    await expect(member.action(blueprints.check, { orgId: f.orgId, blueprint: repair })).rejects.toThrow();
    await expect(member.query(blueprints.preview, { orgId: f.orgId, blueprint: repair })).rejects.toThrow();
    expect((await counts(f)).objects).toBe((await shapeOf(f)).length);
    expect((await shapeOf(f)).some((o: any) => o.key === "repairJob")).toBe(false);
  });
  it("an admin agent that cannot read every object cannot propose a blueprint", async () => {
    const { f, agent, call } = await adminAgent();
    const opportunity = await objectFields(f.client, f.orgId, "opportunity");
    await f.t.run((ctx: any) => ctx.db.patch(agent.agentId, { authorityVersion: 1, readObjectIds: [opportunity.object._id] }));
    const reply = await propose(call, { version: 1, name: "x", description: "", changes: [{ kind: "addField", object: "opportunity", key: "budget", label: "Budget", type: "number" }] });
    expect([reply.status, reply.json.error.code]).toEqual([403, "FORBIDDEN"]);
  });
});

describe("blueprints need sight of every record", () => {
  it("an admin agent limited to some records of an object cannot propose one, so a trial cannot probe hidden records", async () => {
    const { f, agent, call } = await adminAgent();
    const company = await objectFields(f.client, f.orgId, "company"), all: any[] = await f.t.run((ctx: any) => ctx.db.query("objects").collect());
    const make = (name: string) => f.client.mutation(api.records.create, { orgId: f.orgId, objectId: company.object._id, values: { [company.fields.name._id]: name } });
    const shown = await make("Shown Co"); await make("Hidden Co");
    await f.t.run((ctx: any) => ctx.db.patch(agent.agentId, { authorityVersion: 1, readObjectIds: all.filter((o: any) => o.key !== "company").map((o: any) => o._id) }));
    await f.client.mutation(anyApi["authority/grants"].grant, { orgId: f.orgId, target: agent.agentId, capability: "read", scope: { kind: "records", objectId: company.object._id, records: [shown.recordId ?? shown], fields: Object.values(company.fields).map((x: any) => x._id) }, mode: "direct", delegate: false, expiresAt: Date.now() + 600000 });
    const ask = (name: string) => propose(call, { version: 1, name: "probe", description: "", changes: [{ kind: "addField", object: "person", key: "probe", label: "Probe", type: "text", indexed: false }], records: [{ object: "person", values: { name: "P", company: name } }] });
    const hidden = await ask("Hidden Co"), absent = await ask("Absent Co");
    expect([hidden.status, hidden.json.error.code]).toEqual([403, "FORBIDDEN"]);
    expect(absent.json).toEqual(hidden.json);
    expect(await pending(f)).toEqual([]);
  });
});

describe("MCP client", () => {
  it("lists, exports and proposes blueprints over REST", async () => {
    const requests: { method: string; url: string; body?: string }[] = [];
    const client = new RemoldClient({ url: "https://remold.convex.site", key: "rm_x", fetch: (async (url: string, init: RequestInit) => { requests.push({ method: init.method!, url, body: init.body as string | undefined }); return new Response("{}", { status: 200 }); }) as unknown as typeof fetch });
    await client.blueprints();
    await client.currentBlueprint();
    await client.proposeBlueprint({ blueprint: repair, reason: "repairs" });
    expect(requests.map((r) => [r.method, r.url])).toEqual([["GET", "https://remold.convex.site/api/v1/blueprints"], ["GET", "https://remold.convex.site/api/v1/blueprints/current"], ["POST", "https://remold.convex.site/api/v1/shape/proposals"]]);
    expect(JSON.parse(requests[2]!.body!)).toEqual({ kind: "blueprint", blueprint: repair, reason: "repairs" });
  });
});
