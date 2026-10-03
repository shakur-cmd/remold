import { describe, expect, it, vi } from "vitest";
import { anyApi } from "convex/server";
import { agentFor, api, bulk, objectFields, rest, userAndOrg } from "./test.helpers";

// Round 3: the independent verifier's probes (iv-K-probe*.test.ts), adopted. The starter-record
// probe is inverted: it showed agent rules bypassed, and now asserts they hold.
const shape = anyApi.shapeSuggestions, blueprints = anyApi.blueprints;
type F = Awaited<ReturnType<typeof userAndOrg>>;
const propose = (call: ReturnType<typeof rest>, blueprint: unknown) => call("POST", "/api/v1/shape/proposals", { kind: "blueprint", reason: "probe", blueprint });
async function adminAgent(name = "shaper") { const f = await userAndOrg(); const agent = await agentFor(f.client, f.orgId, { name, role: "admin" }); return { f, agent, call: rest(f.t, agent.key) }; }
const pending = (f: F) => f.client.query(shape.list, { orgId: f.orgId, status: "pending" });
const table = (f: F, name: string) => f.t.run((ctx: any) => ctx.db.query(name).collect()) as Promise<any[]>;
const scheduled = (f: F) => f.t.run(async (ctx: any) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((j: any) => !j.name.startsWith("telemetry") && (j.state.kind === "pending" || j.state.kind === "inProgress"))) as Promise<any[]>;

const guarded = (f: F) => objectFields(f.client, f.orgId, "company").then((company) => f.client.mutation(api.fields.update, { orgId: f.orgId, fieldId: company.fields.domain._id, protectedFromAgents: true }));
const withRecords = (records: unknown[]) => ({ version: 1, name: "Helpful setup", description: "", changes: [{ kind: "addField", object: "company", key: "tier", label: "Tier", type: "text", indexed: false }], records });

describe("IV-K B1: an agent's starter records follow every agent rule", () => {
  const cases: [string, unknown[], string][] = [
    ["automation on", [{ object: "automation", values: { name: "Every new company gets a task", when: "recordCreated", object: "company", actions: JSON.stringify([{ type: "createTask", title: "Call {{record.name}}", dueInDays: 1, about: "trigger" }]), status: "on" } }], "Starter record 1 (Automation): Only a person can turn on an automation"],
    ["campaign active", [{ object: "campaign", values: { name: "Started by nobody", status: "active", channel: "Email" } }], "Starter record 1 (Campaign): Only a person can start a campaign"],
    ["email approved", [{ object: "campaign", values: { name: "Draft campaign" } }, { object: "email", values: { subject: "Approved by nobody", body: "hi", campaign: "Draft campaign", status: "approved" } }], "Starter record 2 (Email): Only a person can approve an email"],
    ["post published", [{ object: "post", values: { title: "Published by nobody", status: "published", publishedLink: "https://x.test/p" } }], "Starter record 1 (Post): Only a person can approve or publish a post"],
    ["protected field", [{ object: "company", values: { name: "Acme", domain: "protected.example" } }], "Starter record 1 (Company): Domain is protected from agents; a person must change it"],
  ];
  for (const [name, records, message] of cases) it(`refuses at proposal: ${name}`, async () => {
    const { f, call } = await adminAgent();
    await guarded(f);
    const before = await table(f, "records"), made = await propose(call, withRecords(records));
    expect([made.status, made.json.error?.message]).toEqual([403, message]);
    expect(await pending(f)).toEqual([]);
    expect(await table(f, "records")).toEqual(before);
  });

  it("refuses again at apply: a field protected after the proposal fails the blueprint, nothing applied", async () => {
    const { f, call } = await adminAgent();
    expect((await propose(call, withRecords([{ object: "company", values: { name: "Acme", domain: "acme.example" } }]))).status).toBe(201);
    await guarded(f);
    const [card] = await pending(f), objects = await table(f, "fields");
    expect(await f.client.action(shape.applyBlueprint, { orgId: f.orgId, id: card._id, withRecords: true })).toEqual({ status: "failed", error: "Starter record 1 (Company): Domain is protected from agents; a person must change it" });
    expect(await table(f, "fields")).toEqual(objects);
    expect(await table(f, "records")).toEqual([]);
  });

  it("allowed starter records are the agent's, approved by the person, and an automation stays a draft", async () => {
    const { f, agent, call } = await adminAgent();
    const made = await propose(call, withRecords([{ object: "automation", values: { name: "Draft helper", when: "recordCreated", object: "company", actions: JSON.stringify([{ type: "createTask", title: "Call {{record.name}}", dueInDays: 1, about: "trigger" }]) } }, { object: "company", values: { name: "Acme", tier: "gold" } }]));
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    const [card] = await pending(f);
    expect(await f.client.action(shape.applyBlueprint, { orgId: f.orgId, id: card._id, withRecords: true })).toMatchObject({ status: "applied" });
    const automation = await objectFields(f.client, f.orgId, "automation"), rows = await table(f, "records"), events = await table(f, "events");
    const draft = rows.find((r) => r.objectId === automation.object._id);
    expect(draft.values[automation.fields.status._id]).toBe("draft");
    expect(await table(f, "automationState")).toEqual([]);
    expect(rows.every((r) => r.createdBy === agent.agentId)).toBe(true);
    expect(events.filter((e) => rows.some((r) => r._id === e.recordId)).every((e) => e.actor.kind === "agent" && e.actor.id === agent.agentId)).toBe(true);
  });

  it("an agent cannot put starter records on an archived object", async () => {
    const f = await userAndOrg();
    const workshop = await f.client.mutation(api.objects.create, { orgId: f.orgId, key: "workshop", label: "Workshop", labelPlural: "Workshops" });
    await f.client.mutation(api.objects.setArchived, { orgId: f.orgId, objectId: workshop, archived: true });
    const call = rest(f.t, (await agentFor(f.client, f.orgId, { name: "shaper", role: "admin" })).key);
    const made = await propose(call, withRecords([{ object: "workshop", values: { name: "Pottery" } }]));
    expect([made.status, made.json.error?.message]).toEqual([400, "Starter record 1 (Workshop): Unarchive Workshops to add records"]);
  });

  it("a person's own template or pasted blueprint still writes as the person", async () => {
    const f = await userAndOrg();
    await f.client.mutation(blueprints.apply, { orgId: f.orgId, withRecords: true, blueprint: withRecords([{ object: "campaign", values: { name: "Mine", status: "active" } }]) });
    const user = await f.client.query(api.users.me, {}), rows = await table(f, "records");
    expect(rows.map((r) => [r.title, r.createdBy])).toEqual([["Mine", user!._id]]);
  });

  it("the card lists each starter record's values, not only counts", async () => {
    const { f, call } = await adminAgent();
    const records = Array.from({ length: 12 }, (_, i) => ({ object: "company", values: { name: `Co ${i}`, tier: i % 2 ? "gold" : "silver" } }));
    expect((await propose(call, withRecords(records))).status).toBe(201);
    const [card] = await pending(f);
    expect(card.blueprint.starter).toHaveLength(12);
    expect(card.blueprint.starter[1]).toEqual({ object: "Company", values: [{ label: "Name", value: "Co 1" }, { label: "Tier", value: "gold" }] });
  });

  it("check leaves starter records out unless asked, and names a missing required value", async () => {
    const f = await userAndOrg();
    const plan = { version: 1, name: "x", description: "", changes: [{ kind: "addField", object: "person", key: "nick", label: "Nick", type: "text", indexed: false }], records: [{ object: "person", values: { nick: "no name" } }] };
    expect(await f.client.action(blueprints.check, { orgId: f.orgId, blueprint: plan })).toMatchObject({ ok: true, records: 0 });
    expect(await f.client.action(blueprints.check, { orgId: f.orgId, blueprint: plan, withRecords: true })).toEqual({ ok: false, error: "Starter record 1 (Person): Name is required" });
  });
});

describe("IV-K probe 2: hidden field", () => {
  it("an admin agent with a hidden field cannot propose a blueprint, and export still works filtered", async () => {
    const f = await userAndOrg(); const agent = await agentFor(f.client, f.orgId, { name: "s", role: "admin" }); const call = rest(f.t, agent.key);
    const company = await objectFields(f.client, f.orgId, "company");
    await f.t.run((ctx: any) => ctx.db.patch(agent.agentId, { hiddenFieldIds: [company.fields.domain._id] }));
    const reply = await call("POST", "/api/v1/shape/proposals", { kind: "blueprint", reason: "r", blueprint: { version: 1, name: "x", description: "", changes: [{ kind: "addField", object: "person", key: "nick", label: "Nick", type: "text", indexed: false }] } });
    expect([reply.status, reply.json.error.code]).toEqual([403, "FORBIDDEN"]);
    const exported = await call("GET", "/api/v1/blueprints/current");
    expect(exported.status).toBe(200);
    expect(JSON.stringify(exported.json)).not.toContain('"domain"');
  });
});

describe("IV-K: a trial leaves nothing behind", () => {
  it("proposing a blueprint that retitles a large object and adds objects schedules nothing, flags nothing, audits nothing", async () => {
    vi.useFakeTimers();
    try {
      const { f, agent, call } = await adminAgent();
      const company = (await objectFields(f.client, f.orgId, "company")).fields;
      await bulk(f.t, f.orgId, async (apply) => { for (let i = 0; i < 120; i++) await apply({ action: "create", objectId: company.name.objectId, values: { [company.name._id]: `Co${i}`, [company.domain._id]: `s${i}.test` } }); });
      const before = { scheduled: await scheduled(f), audit: (await table(f, "authorityAudit")).length, events: (await table(f, "events")).length, objects: (await table(f, "objects")).length, views: (await table(f, "views")).length, agent: await f.t.run((ctx: any) => ctx.db.get(agent.agentId)) };
      const made = await propose(call, { version: 1, name: "Titles", description: "", changes: [
        { kind: "setTitleField", object: "company", field: "domain" },
        { kind: "addObject", key: "job", label: "Job", labelPlural: "Jobs", fields: [{ key: "status", label: "Status", type: "select", options: [{ id: "a", label: "A" }] }] },
        { kind: "addView", object: "job", name: "Board", layout: "board", groupBy: "status" },
      ], records: [{ object: "job", values: { name: "J1", status: "A" } }] });
      expect(made.status, JSON.stringify(made.json)).toBe(201);
      const object: any = await f.t.run((ctx: any) => ctx.db.get(company.name.objectId));
      expect(object.retitling).toBeUndefined();
      expect(object.titleFieldId).toBe(company.name._id);
      expect(await scheduled(f)).toEqual(before.scheduled);
      expect((await table(f, "authorityAudit")).length).toBe(before.audit);
      expect((await table(f, "events")).length).toBe(before.events);
      expect((await table(f, "objects")).length).toBe(before.objects);
      expect((await table(f, "views")).length).toBe(before.views);
      expect(await f.t.run((ctx: any) => ctx.db.get(agent.agentId))).toEqual(before.agent);
      expect((await table(f, "records")).every((r) => r.title.startsWith("Co"))).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});

describe("IV-K: size limits", () => {
  it("a blueprint at the limits (20 objects x 12 fields, 100 changes, 50 records) applies as one", async () => {
    const f = await userAndOrg();
    const fieldsFor = (i: number) => [
      ...Array.from({ length: 5 }, (_, k) => ({ key: `t${k}`, label: `T${k}`, type: "text" })),
      { key: "status", label: "Status", type: "select", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
      { key: "link", label: "Link", type: "lookup", target: `o${(i + 1) % 20}` },
      { key: "n0", label: "N0", type: "number" }, { key: "n1", label: "N1", type: "number" },
      { key: "d0", label: "D0", type: "date" }, { key: "d1", label: "D1", type: "date" },
      { key: "b0", label: "B0", type: "boolean" },
    ];
    const objects = Array.from({ length: 20 }, (_, i) => ({ kind: "addObject", key: `o${i}`, label: `O${i}`, labelPlural: `O${i}s`, fields: fieldsFor(i) }));
    const others = [
      ...Array.from({ length: 20 }, (_, i) => ({ kind: "addField", object: `o${i}`, key: "notes", label: "Notes", type: "text", indexed: false })),
      ...Array.from({ length: 20 }, (_, i) => ({ kind: "addView", object: `o${i}`, name: `Board ${i}`, layout: "board", groupBy: "status", pinned: i < 3 })),
      ...Array.from({ length: 20 }, (_, i) => ({ kind: "relabel", object: `o${i}`, field: "name", label: "Title" })),
      ...Array.from({ length: 19 }, (_, i) => ({ kind: "addOptions", object: `o${i}`, field: "status", options: [{ id: "c", label: "C" }] })),
      { kind: "setTitleField", object: "o0", field: "t0" },
    ];
    const plan = { version: 1, name: "Max", description: "", changes: [...objects, ...others], records: Array.from({ length: 50 }, (_, i) => ({ object: `o${i % 20}`, values: { name: `R${i}`, t0: `R${i}`, status: "A", n0: i, ...(i >= 20 ? { link: `R${(i % 20 + 1) % 20}` } : {}) } })) };
    expect(plan.changes.length).toBe(100);
    const checked = await f.client.action(blueprints.check, { orgId: f.orgId, blueprint: plan, withRecords: true }); expect(checked, JSON.stringify(checked)).toMatchObject({ ok: true, records: 50 });
    await f.client.mutation(blueprints.apply, { orgId: f.orgId, blueprint: plan, withRecords: true });
    expect((await table(f, "records")).length).toBe(50);
    expect((await table(f, "views")).length).toBe(20);
    expect((await objectFields(f.client, f.orgId, "o0")).fields.t0._id).toBe((await objectFields(f.client, f.orgId, "o0")).object.titleFieldId);
  }, 60_000);
});

describe("IV-K: templates on a lived-in workspace", () => {
  it("each template applies, or refuses in plain words, where standard fields are retired and a custom object with a clashing key is archived", async () => {
    const templates: any[] = await (await userAndOrg()).client.query(blueprints.templates, {});
    const outcomes: Record<string, string> = {};
    for (const { id, blueprint } of templates) {
      const f = await userAndOrg();
      const company = await objectFields(f.client, f.orgId, "company");
      await f.client.mutation(api.fields.retire, { orgId: f.orgId, fieldId: company.fields.city._id });
      const jobId = await f.client.mutation(api.objects.create, { orgId: f.orgId, key: "job", label: "Old Job", labelPlural: "Old Jobs" });
      await f.client.mutation(api.objects.setArchived, { orgId: f.orgId, objectId: jobId, archived: true });
      await f.client.mutation(api.records.create, { orgId: f.orgId, objectId: company.object._id, values: { [company.fields.name._id]: "Existing Co" } });
      const result = await f.client.action(blueprints.check, { orgId: f.orgId, blueprint, withRecords: true });
      outcomes[id] = result.ok ? "ok" : result.error;
      if (result.ok) { await f.client.mutation(blueprints.apply, { orgId: f.orgId, blueprint, withRecords: true }); expect((await table(f, "records")).length, id).toBe(1 + (blueprint.records?.length ?? 0)); }
    }
    expect(outcomes).toEqual({ service: "Step 1, add object job: Object key already exists", agency: "ok", creator: "ok", retail: "ok" });
  }, 60_000);
});
