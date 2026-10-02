import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentFor, api, objectFields, rest, userAndOrg } from "./test.helpers";
import { requireAgent } from "./identity";
import { applyChange } from "./lib/applyChange";
import { createHash } from "node:crypto";
import { internal } from "./_generated/api";
import { insert } from "./agents";

// Production needs REMOLD_INTAKE_DAILY_CAP set; unset it means zero leads.
beforeEach(() => { vi.stubEnv("REMOLD_INTAKE_DAILY_CAP", "50"); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const post = (t: any, key: string, path: string, body: unknown, idempotencyKey?: string) => t.fetch(path, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) }, body: JSON.stringify(body) }).then(async (r: Response) => ({ status: r.status, headers: r.headers, json: await r.json() }));
const counts = (t: any) => t.run(async (ctx: any) => { const objects = await ctx.db.query("objects").collect(), records = await ctx.db.query("records").collect(); const by = (key: string) => records.filter((r: any) => r.objectId === objects.find((o: any) => o.key === key)?._id); return { person: by("person").length, company: by("company").length, opportunity: by("opportunity").length, note: by("note").length, events: (await ctx.db.query("events").collect()).length }; });
const recordsOf = (t: any, key: string) => t.run(async (ctx: any) => { const object = (await ctx.db.query("objects").collect()).find((o: any) => o.key === key); return ctx.db.query("records").withIndex("by_object", (q: any) => q.eq("orgId", object.orgId).eq("objectId", object._id)).collect(); });
const lead = { name: "Shakur Abdul", email: "shakur@x.com", phone: "+1 (410) 555-0100", company: "CodeMyVibe", message: "Need a CRM", source: "website", campaign: "fall-audit" };

async function intakeSetup() {
  const setup = await userAndOrg();
  const intake = await setup.client.action(api.agents.createIntake, { orgId: setup.orgId });
  const send = (body: unknown, key?: string) => post(setup.t, intake.key, "/api/v1/intake/lead", body, key);
  return { ...setup, intake, send };
}

describe("Idempotency-Key on POST /api/v1/changes", () => {
  it("returns the original result for a repeated key and body without writing again", async () => {
    const { t, client, orgId } = await userAndOrg();
    const agent = await agentFor(client, orgId, { name: "writer", grants: [{ action: "create", objectKey: "company" }] });
    const body = { action: "create", object: "company", values: { name: "Atlas" }, reason: "import" };
    const first = await post(t, agent.key, "/api/v1/changes", body, "import-atlas-1");
    const before = await counts(t);
    const again = await post(t, agent.key, "/api/v1/changes", body, "import-atlas-1");
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.json).toEqual(first.json);
    expect(await counts(t)).toEqual(before);
    expect(before.company).toBe(1);
  });

  it("refuses the same key with a different body and writes nothing", async () => {
    const { t, client, orgId } = await userAndOrg();
    const agent = await agentFor(client, orgId, { name: "writer", grants: [{ action: "create", objectKey: "company" }] });
    await post(t, agent.key, "/api/v1/changes", { action: "create", object: "company", values: { name: "Atlas" }, reason: "import" }, "k1");
    const before = await counts(t);
    const reused = await post(t, agent.key, "/api/v1/changes", { action: "create", object: "company", values: { name: "Borealis" }, reason: "import" }, "k1");
    expect(reused.status).toBe(422);
    expect(reused.json.error.code).toBe("IDEMPOTENCY_MISMATCH");
    expect(await counts(t)).toEqual(before);
  });

  it("scopes keys to the agent key and forgets them after the 24 hour window", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const { t, client, orgId } = await userAndOrg();
    const grants = [{ action: "create" as const, objectKey: "company" }];
    const a = await agentFor(client, orgId, { name: "a", grants }), b = await agentFor(client, orgId, { name: "b", grants });
    const body = { action: "create", object: "company", values: { name: "Atlas" }, reason: "import" };
    await post(t, a.key, "/api/v1/changes", body, "shared");
    expect((await post(t, b.key, "/api/v1/changes", body, "shared")).status).toBe(200);
    expect((await counts(t)).company).toBe(2);
    clock.mockReturnValue(1_800_000_000_000 + 24 * 3600_000 - 1);
    await post(t, a.key, "/api/v1/changes", body, "shared");
    expect((await counts(t)).company).toBe(2);
    clock.mockReturnValue(1_800_000_000_000 + 24 * 3600_000 + 1);
    await post(t, a.key, "/api/v1/changes", body, "shared");
    expect((await counts(t)).company).toBe(3);
  });

  it("re-checks current read access on replay and refuses once the read grant is revoked, without writing again", async () => {
    const { t, client, orgId } = await userAndOrg();
    const person = await objectFields(client, orgId, "person");
    const created = await client.mutation(api.records.create, { orgId, objectId: person.object._id, values: { [person.fields.name._id]: "Private Person", [person.fields.email._id]: "private@x.com" } });
    const agent = await client.action(api.agents.createScoped, { orgId, name: "scoped", origin: "external" });
    const scope = (fields: string[]) => ({ kind: "records" as const, objectId: person.object._id, records: "all" as const, fields: fields.map((key) => person.fields[key]._id) });
    const read = await client.mutation(api.authority.grants.grant, { orgId, target: agent.agentId, capability: "read", scope: scope(["name", "email"]), mode: "direct", delegate: false, expiresAt: Date.now() + 3600_000 });
    await client.mutation(api.authority.grants.grant, { orgId, target: agent.agentId, capability: "record.update", scope: scope(["name"]), mode: "direct", delegate: false, expiresAt: Date.now() + 3600_000 });
    const body = { action: "update", record: created.recordId, values: { name: "Renamed" }, reason: "fix" };
    const first = await post(t, agent.key, "/api/v1/changes", body, "cached");
    expect(first.status).toBe(200);
    await client.mutation(api.authority.grants.revoke, { orgId, id: read });
    const before = await counts(t);
    const replayed = await post(t, agent.key, "/api/v1/changes", body, "cached");
    expect(replayed.status).toBe(403);
    expect(JSON.stringify(replayed.json)).not.toContain("private@x.com");
    expect(await counts(t)).toEqual(before);
  });

  it("returns only fields still readable when a field is hidden after the original write", async () => {
    const { t, client, orgId } = await userAndOrg();
    const person = await objectFields(client, orgId, "person");
    const created = await client.mutation(api.records.create, { orgId, objectId: person.object._id, values: { [person.fields.name._id]: "Person", [person.fields.email._id]: "secret@x.com" } });
    const agent = await agentFor(client, orgId, { name: "writer", grants: [{ action: "update", objectKey: "person" }] });
    const body = { action: "update", record: created.recordId, values: { name: "Renamed" }, reason: "fix" };
    expect((await post(t, agent.key, "/api/v1/changes", body, "masked")).json.record.values.email).toBe("secret@x.com");
    await client.mutation(api.authority.policies.setAgentMasks, { orgId, agentId: agent.agentId, hiddenFieldIds: [person.fields.email._id] });
    const before = await counts(t);
    const replayed = await post(t, agent.key, "/api/v1/changes", body, "masked");
    expect(replayed.status).toBe(200);
    expect(replayed.json.record.values.name).toBe("Renamed");
    expect(JSON.stringify(replayed.json)).not.toContain("secret@x.com");
    expect(await counts(t)).toEqual(before);
  });

  it("replays the original result, not a later human edit", async () => {
    const { t, client, orgId } = await userAndOrg();
    const agent = await agentFor(client, orgId, { name: "writer", grants: [{ action: "create", objectKey: "company" }] });
    const company = await objectFields(client, orgId, "company");
    const body = { action: "create", object: "company", values: { name: "Original Company", city: "Baltimore" }, reason: "intake" };
    const first = await post(t, agent.key, "/api/v1/changes", body, "original");
    await client.mutation(api.records.update, { orgId, recordId: first.json.record.id, values: { [company.fields.name._id]: "Later Human Edit", [company.fields.domain._id]: "later.example" } });
    const before = await counts(t);
    const replayed = await post(t, agent.key, "/api/v1/changes", body, "original");
    expect(replayed.status).toBe(200);
    expect(replayed.json).toEqual(first.json);
    expect(JSON.stringify(replayed.json)).not.toContain("later.example");
    expect(await counts(t)).toEqual(before);
  });

  it("never adds a field to a replay that was hidden when the change was made", async () => {
    const { t, client, orgId } = await userAndOrg();
    const person = await objectFields(client, orgId, "person");
    const created = await client.mutation(api.records.create, { orgId, objectId: person.object._id, values: { [person.fields.name._id]: "Person", [person.fields.email._id]: "was-hidden@x.com" } });
    const agent = await agentFor(client, orgId, { name: "writer", grants: [{ action: "update", objectKey: "person" }] });
    await client.mutation(api.authority.policies.setAgentMasks, { orgId, agentId: agent.agentId, hiddenFieldIds: [person.fields.email._id] });
    const body = { action: "update", record: created.recordId, values: { name: "Renamed" }, reason: "fix" };
    const first = await post(t, agent.key, "/api/v1/changes", body, "unhidden");
    await client.mutation(api.authority.policies.setAgentMasks, { orgId, agentId: agent.agentId, hiddenFieldIds: [] });
    const replayed = await post(t, agent.key, "/api/v1/changes", body, "unhidden");
    expect(replayed.status).toBe(200);
    expect(replayed.json).toEqual(first.json);
    expect(JSON.stringify(replayed.json)).not.toContain("was-hidden@x.com");
  });

  it("refuses a replay when the record has since been deleted, without writing again", async () => {
    const { t, client, orgId } = await userAndOrg();
    const agent = await agentFor(client, orgId, { name: "writer", grants: [{ action: "create", objectKey: "company" }] });
    const body = { action: "create", object: "company", values: { name: "Gone Co" }, reason: "intake" };
    const first = await post(t, agent.key, "/api/v1/changes", body, "gone");
    await client.mutation(api.records.remove, { orgId, recordId: first.json.record.id });
    const before = await counts(t);
    expect((await post(t, agent.key, "/api/v1/changes", body, "gone")).status).toBe(404);
    expect(await counts(t)).toEqual(before);
  });

  it("dedupes ten concurrent identical changes into one write", async () => {
    const { t, client, orgId } = await userAndOrg();
    const agent = await agentFor(client, orgId, { name: "writer", grants: [{ action: "create", objectKey: "company" }] });
    const body = { action: "create", object: "company", values: { name: "Parallel" }, reason: "burst" };
    const results = await Promise.all(Array.from({ length: 10 }, () => post(t, agent.key, "/api/v1/changes", body, "parallel")));
    expect(results.every((r: any) => r.status === 200 && r.json.record.id === results[0].json.record.id)).toBe(true);
    expect((await counts(t)).company).toBe(1);
  });

  it("still writes every time when no key is sent", async () => {
    const { t, client, orgId } = await userAndOrg();
    const agent = await agentFor(client, orgId, { name: "writer", grants: [{ action: "create", objectKey: "company" }] });
    const body = { action: "create", object: "company", values: { name: "Atlas" }, reason: "import" };
    await post(t, agent.key, "/api/v1/changes", body);
    await post(t, agent.key, "/api/v1/changes", body);
    expect((await counts(t)).company).toBe(2);
  });
});

describe("POST /api/v1/intake/lead", () => {
  it("lands the same lead once when it is sent twice with the same key", async () => {
    const { t, send, intake } = await intakeSetup();
    const first = await send(lead, "lead-001");
    const again = await send(lead, "lead-001");
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.json).toEqual(first.json);
    expect(await counts(t)).toMatchObject({ person: 1, company: 1, opportunity: 1, note: 1 });
    const [opportunity] = await recordsOf(t, "opportunity"), [person] = await recordsOf(t, "person"), [note] = await recordsOf(t, "note"), [company] = await recordsOf(t, "company");
    const fields = await t.run(async (ctx: any) => Object.fromEntries((await ctx.db.query("fields").collect()).map((f: any) => [`${(f as any).objectId}:${f.key}`, f._id])));
    const field = (record: any, key: string) => record.values[fields[`${record.objectId}:${key}`]];
    expect(field(opportunity, "stage")).toBe("new");
    expect(field(opportunity, "person")).toBe(person._id);
    expect(field(opportunity, "company")).toBe(company._id);
    expect(field(person, "email")).toBe("shakur@x.com");
    expect(field(person, "phone")).toBe("+14105550100");
    expect(field(person, "company")).toBe(company._id);
    expect(field(note, "about")).toBe(opportunity._id);
    expect(field(note, "body")).toContain("Need a CRM");
    expect(field(note, "body")).toContain("Source: website");
    expect(field(note, "body")).toContain("Campaign: fall-audit");
    expect(first.json).toEqual({ opportunity: { id: opportunity._id, ref: opportunity.ref } });
    const events: any[] = await t.run((ctx: any) => ctx.db.query("events").collect());
    expect(events.length).toBe(4);
    expect(events.every((e: any) => e.actor.kind === "agent" && e.actor.id === intake.agentId)).toBe(true);
  });

  it("lands two simultaneous identical calls once", async () => {
    const { t, send } = await intakeSetup();
    const [a, b] = await Promise.all([send(lead, "lead-002"), send(lead, "lead-002")]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.json).toEqual(a.json);
    expect(await counts(t)).toMatchObject({ person: 1, opportunity: 1, note: 1 });
  });

  it("refuses the same key with a different body", async () => {
    const { t, send } = await intakeSetup();
    await send(lead, "lead-003");
    const before = await counts(t);
    const changed = await send({ ...lead, message: "Something else" }, "lead-003");
    expect(changed.status).toBe(422);
    expect(changed.json.error.code).toBe("IDEMPOTENCY_MISMATCH");
    expect(await counts(t)).toEqual(before);
  });

  it("requires an Idempotency-Key", async () => {
    const { t, send } = await intakeSetup();
    const before = await counts(t);
    const missing = await send(lead);
    expect(missing.status).toBe(400);
    expect(await counts(t)).toEqual(before);
  });

  it("matches the same person whatever the email's case and spacing", async () => {
    const { t, send } = await intakeSetup();
    await send({ name: "Shakur", email: "Shakur@X.com " }, "a");
    await send({ name: "Shakur A.", email: "shakur@x.com" }, "b");
    expect(await counts(t)).toMatchObject({ person: 1, opportunity: 2 });
  });

  it("matches people entered through ordinary CRM writes with different email formatting, keeping their stored value", async () => {
    const { t, client, orgId, send } = await intakeSetup();
    const person = await objectFields(client, orgId, "person");
    const existing = await client.mutation(api.records.create, { orgId, objectId: person.object._id, values: { [person.fields.name._id]: "Shakur", [person.fields.email._id]: "Shakur@X.com " } });
    expect((await send({ name: "Shakur", email: "shakur@x.com" }, "crm-email")).status).toBe(201);
    expect((await counts(t)).person).toBe(1);
    const [opp] = await recordsOf(t, "opportunity");
    const opportunity = await objectFields(client, orgId, "opportunity");
    expect(opp.values[opportunity.fields.person._id]).toBe(existing.recordId);
    expect((await client.query(api.records.get, { orgId, recordId: existing.recordId }))!.record.values[person.fields.email._id]).toBe("Shakur@X.com ");
  });

  it("matches people entered through ordinary CRM writes with different phone formatting, keeping their stored value", async () => {
    const { t, client, orgId, send } = await intakeSetup();
    const person = await objectFields(client, orgId, "person");
    const existing = await client.mutation(api.records.create, { orgId, objectId: person.object._id, values: { [person.fields.name._id]: "Caller", [person.fields.phone._id]: "+1 (410) 555-0100" } });
    expect((await send({ name: "Caller", email: "caller@x.com", phone: "+14105550100" }, "crm-phone")).status).toBe(201);
    expect((await counts(t)).person).toBe(1);
    const record = (await client.query(api.records.get, { orgId, recordId: existing.recordId }))!.record;
    expect(record.values[person.fields.phone._id]).toBe("+1 (410) 555-0100");
    expect(record.values[person.fields.email._id]).toBeUndefined();
  });

  it("falls back to the phone number and changes nothing on that person", async () => {
    const { t, client, orgId, send } = await intakeSetup();
    const person = await objectFields(client, orgId, "person"), opportunity = await objectFields(client, orgId, "opportunity");
    const values = { [person.fields.name._id]: "Original Name", [person.fields.phone._id]: "+14105550100", [person.fields.title._id]: "Owner", [person.fields.email._id]: "old@x.com" };
    const existing = await client.mutation(api.records.create, { orgId, objectId: person.object._id, values });
    await send({ name: "Changed Name", email: "new@x.com", phone: "+1 410 555 0100", company: "Acme" }, "c");
    expect((await counts(t)).person).toBe(1);
    expect((await client.query(api.records.get, { orgId, recordId: existing.recordId }))!.record.values).toEqual(values);
    const [opp] = await recordsOf(t, "opportunity");
    expect(opp.values[opportunity.fields.person._id]).toBe(existing.recordId);
  });

  it("never merges when email and phone point at different people, and flags it", async () => {
    const { t, client, orgId, send } = await intakeSetup();
    const person = await objectFields(client, orgId, "person"), opportunity = await objectFields(client, orgId, "opportunity"), note = await objectFields(client, orgId, "note");
    const byEmail = await client.mutation(api.records.create, { orgId, objectId: person.object._id, values: { [person.fields.name._id]: "Email Person", [person.fields.email._id]: "shakur@x.com" } });
    await client.mutation(api.records.create, { orgId, objectId: person.object._id, values: { [person.fields.name._id]: "Phone Person", [person.fields.phone._id]: "+14105550100" } });
    await send(lead, "d");
    expect((await counts(t)).person).toBe(2);
    const [opp] = await recordsOf(t, "opportunity"), [n] = await recordsOf(t, "note");
    expect(opp.values[opportunity.fields.person._id]).toBe(byEmail.recordId);
    expect(n.values[note.fields.body._id]).toMatch(/phone .*Phone Person/i);
    const people = await recordsOf(t, "person");
    expect(people.find((p: any) => p.title === "Phone Person").values[person.fields.email._id]).toBeUndefined();
  });

  it("links an existing person matched by email without changing them; the submitted details go only in the Note", async () => {
    const { t, client, orgId, send } = await intakeSetup();
    const person = await objectFields(client, orgId, "person"), opportunity = await objectFields(client, orgId, "opportunity"), note = await objectFields(client, orgId, "note");
    const existing = await client.mutation(api.records.create, { orgId, objectId: person.object._id, values: { [person.fields.name._id]: "Shakur", [person.fields.email._id]: "shakur@x.com" } });
    const before = (await client.query(api.records.get, { orgId, recordId: existing.recordId }))!.record;
    expect((await send(lead, "keep-email")).status).toBe(201);
    const after = (await client.query(api.records.get, { orgId, recordId: existing.recordId }))!.record;
    expect(after.values).toEqual(before.values);
    expect(after.updatedAt).toBe(before.updatedAt);
    const [opp] = await recordsOf(t, "opportunity"), [n] = await recordsOf(t, "note");
    expect(opp.values[opportunity.fields.person._id]).toBe(existing.recordId);
    expect(n.values[note.fields.body._id]).toContain("Submitted: Shakur Abdul, shakur@x.com, +14105550100, CodeMyVibe");
    expect(await t.run((ctx: any) => ctx.db.query("events").withIndex("by_record", (q: any) => q.eq("orgId", orgId).eq("recordId", existing.recordId)).collect()).then((events: any) => events.map((e: any) => e.action))).toEqual(["create"]);
  });

  it("links an existing person matched by phone without filling their empty email or company", async () => {
    const { t, client, orgId, send } = await intakeSetup();
    const person = await objectFields(client, orgId, "person"), note = await objectFields(client, orgId, "note");
    const existing = await client.mutation(api.records.create, { orgId, objectId: person.object._id, values: { [person.fields.name._id]: "Caller", [person.fields.phone._id]: "+1 (410) 555-0100" } });
    expect((await send({ name: "Caller", email: "caller@x.com", phone: "+14105550100", company: "Acme" }, "keep-phone")).status).toBe(201);
    const record = (await client.query(api.records.get, { orgId, recordId: existing.recordId }))!.record;
    expect(record.values).toEqual({ [person.fields.name._id]: "Caller", [person.fields.phone._id]: "+1 (410) 555-0100" });
    const [n] = await recordsOf(t, "note");
    expect(n.values[note.fields.body._id]).toContain("caller@x.com");
    expect((await counts(t)).company).toBe(1);
  });

  it("leaves the email-matched person's empty phone empty when the phone belongs to someone else", async () => {
    const { client, orgId, send } = await intakeSetup();
    const person = await objectFields(client, orgId, "person");
    const byEmail = await client.mutation(api.records.create, { orgId, objectId: person.object._id, values: { [person.fields.name._id]: "Email Person", [person.fields.email._id]: "shakur@x.com" } });
    await client.mutation(api.records.create, { orgId, objectId: person.object._id, values: { [person.fields.name._id]: "Phone Person", [person.fields.phone._id]: "+14105550100" } });
    expect((await send(lead, "conflict-phone")).status).toBe(201);
    expect((await client.query(api.records.get, { orgId, recordId: byEmail.recordId }))!.record.values[person.fields.phone._id]).toBeUndefined();
  });

  it("reuses a company with the same name", async () => {
    const { t, client, orgId, send } = await intakeSetup();
    const company = await objectFields(client, orgId, "company");
    await client.mutation(api.records.create, { orgId, objectId: company.object._id, values: { [company.fields.name._id]: "CodeMyVibe" } });
    await send({ ...lead, company: "codemyvibe " }, "e");
    expect((await counts(t)).company).toBe(1);
  });

  it("reuses an exact company name even when many similar names crowd the search", async () => {
    const { t, client, orgId, send } = await intakeSetup();
    const company = await objectFields(client, orgId, "company");
    for (let i = 0; i < 25; i++) await client.mutation(api.records.create, { orgId, objectId: company.object._id, values: { [company.fields.name._id]: `Acme Branch ${i}` } });
    const acme = await client.mutation(api.records.create, { orgId, objectId: company.object._id, values: { [company.fields.name._id]: "Acme" } });
    expect((await send({ ...lead, company: "Acme" }, "crowded")).status).toBe(201);
    expect((await counts(t)).company).toBe(26);
    const [opp] = await recordsOf(t, "opportunity");
    expect(opp.values[(await objectFields(client, orgId, "opportunity")).fields.company._id]).toBe(acme.recordId);
  });

  it("keeps matching and idempotency keys inside each workspace", async () => {
    const a = await intakeSetup(), b = a.t.withIdentity({ tokenIdentifier: "clerk|B", name: "B" });
    await b.mutation(api.users.store, {});
    const orgB = await b.mutation(api.orgs.create, { name: "B Org" }), keyB = await b.action(api.agents.createIntake, { orgId: orgB });
    expect((await a.send(lead, "shared-key")).status).toBe(201);
    const second = await post(a.t, keyB.key, "/api/v1/intake/lead", lead, "shared-key");
    expect(second.status).toBe(201);
    expect(second.json.opportunity.id).not.toBe((await a.send(lead, "shared-key")).json.opportunity.id);
    const people = ((await a.t.run((ctx: any) => ctx.db.query("records").collect())) as any[]).filter((r) => r.title === lead.name);
    expect(new Set(people.map((p: any) => p.orgId))).toEqual(new Set([a.orgId, orgB]));
    expect(people).toHaveLength(2);
  });

  it("rolls back when the final Note write fails, and the same key then succeeds", async () => {
    const { t, client, orgId, send } = await intakeSetup();
    const note = await objectFields(client, orgId, "note");
    const { fieldId } = await client.mutation(api.fields.create, { orgId, objectId: note.object._id, key: "topic", label: "Topic", type: "text", required: true });
    const before = await counts(t);
    expect((await send(lead, "retry-note")).status).toBe(400);
    expect(await counts(t)).toEqual(before);
    // No API relaxes a required field (and retiring one still enforces it), so the owner's fix is applied directly.
    await t.run((ctx: any) => ctx.db.patch(fieldId, { required: false }));
    expect((await send(lead, "retry-note")).status).toBe(201);
    expect(await counts(t)).toMatchObject({ person: 1, company: 1, opportunity: 1, note: 1 });
  });

  it("leaves no partial records when a later write fails", async () => {
    const { t, client, orgId, send } = await intakeSetup();
    const opportunity = await objectFields(client, orgId, "opportunity");
    // A required Opportunity field the lead cannot fill: Person and Company are written first, then this fails.
    await client.mutation(api.fields.create, { orgId, objectId: opportunity.object._id, key: "budget", label: "Budget", type: "text", required: true });
    const before = await counts(t);
    const failed = await send(lead, "f");
    expect(failed.status).toBe(400);
    expect(await counts(t)).toEqual(before);
    expect(await t.run((ctx: any) => ctx.db.query("idempotencyKeys").collect())).toEqual([]);
  });
});

describe("website intake key", () => {
  it("answers 404 for other intake paths and methods, and when the workspace lacks a field intake writes, writing nothing", async () => {
    const { t, client, orgId, intake, send } = await intakeSetup();
    const before = await counts(t);
    expect((await post(t, intake.key, "/api/v1/intake/leads", lead, "p1")).status).toBe(404);
    expect((await t.fetch("/api/v1/intake/lead", { headers: { authorization: `Bearer ${intake.key}` } })).status).toBe(404);
    const opportunity = await objectFields(client, orgId, "opportunity");
    await client.mutation(api.fields.retire, { orgId, fieldId: opportunity.fields.stage._id });
    const missing = await send(lead, "p2");
    expect(missing.status).toBe(404);
    expect(missing.json.error.code).toBe("NOT_FOUND");
    expect(await counts(t)).toEqual(before);
  });

  it("can submit leads and nothing else", async () => {
    const { t, intake, send } = await intakeSetup();
    await send(lead, "g");
    const call = rest(t, intake.key);
    expect((await call("GET", "/api/v1/records?object=person")).status).toBe(403);
    expect((await call("GET", "/api/v1/records?object=opportunity")).status).toBe(403);
    expect((await call("GET", "/api/v1/me")).status).toBe(403);
    expect((await call("GET", "/api/v1/search?q=Shakur")).status).toBe(403);
    expect((await call("POST", "/api/v1/changes", { action: "create", object: "person", values: { name: "x" }, reason: "x" })).status).toBe(403);
    expect((await call("POST", "/api/v1/suggestions", { action: "create", object: "person", values: { name: "x" }, reason: "x" })).status).toBe(403);
  });

  it("is refused on intake for a normal key, even one with create grants, until it holds the intake grants", async () => {
    const { t, client, orgId } = await userAndOrg();
    const normal = await agentFor(client, orgId, { name: "normal", grants: ["person", "company", "opportunity", "note"].map((objectKey) => ({ action: "create" as const, objectKey })) });
    const before = await counts(t);
    expect((await post(t, normal.key, "/api/v1/intake/lead", lead, "h")).status).toBe(403);
    expect(await counts(t)).toEqual(before);
    const intake = await client.action(api.agents.createIntake, { orgId });
    const grants: any[] = await t.run((ctx: any) => ctx.db.query("capabilityGrants").withIndex("by_agent", (q: any) => q.eq("orgId", orgId).eq("agentId", intake.agentId)).collect());
    for (const g of grants) await client.mutation(api.authority.grants.grant, { orgId, target: normal.agentId, capability: g.capability, scope: g.scope, mode: g.mode, delegate: false, expiresAt: g.expiresAt });
    expect((await post(t, normal.key, "/api/v1/intake/lead", lead, "h")).status).toBe(201);
  });

  it("refuses a replay once an intake grant is revoked", async () => {
    const { t, client, orgId, intake, send } = await intakeSetup();
    expect((await send(lead, "revoked-replay")).status).toBe(201);
    const grants: any[] = await t.run((ctx: any) => ctx.db.query("capabilityGrants").withIndex("by_agent", (q: any) => q.eq("orgId", orgId).eq("agentId", intake.agentId)).collect());
    await client.mutation(api.authority.grants.revoke, { orgId, id: grants[0]._id });
    const before = await counts(t);
    const replayed = await send(lead, "revoked-replay");
    expect(replayed.status).toBe(403);
    expect(await counts(t)).toEqual(before);
  });

  it("refuses leads while the workspace is read only", async () => {
    const { t, orgId, send } = await intakeSetup();
    await t.run((ctx: any) => ctx.db.patch(orgId, { flags: { readonly: true } }));
    const before = await counts(t);
    const refused = await send(lead, "readonly");
    expect(refused.status).toBe(403);
    expect(refused.json.error.message).toMatch(/read only/);
    expect(await counts(t)).toEqual(before);
  });

  it("is created only by the workspace owner", async () => {
    const { t, client, orgId } = await userAndOrg();
    const invite = await client.mutation(api.invites.create, { orgId, role: "admin" });
    const admin = t.withIdentity({ tokenIdentifier: "clerk|admin", name: "Admin" });
    await admin.mutation(api.users.store, {});
    await admin.mutation(api.invites.accept, { token: invite.token });
    await expect(admin.action(api.agents.createIntake, { orgId })).rejects.toThrow();
    expect(await t.run((ctx: any) => ctx.db.query("agents").collect())).toEqual([]);
  });

  describe("created from the CLI (convex run agents:insert with asUserId)", () => {
    const key = `rm_${"c".repeat(40)}`;
    const cli = (t: any, orgId: any, asUserId: any, extra: Record<string, unknown> = {}) => t.mutation(internal.agents.insert, { orgId, name: "Website intake key", origin: "external", scoped: true, intake: true, keyHash: createHash("sha256").update(key).digest("hex"), keyPrefix: key.slice(0, 12), asUserId, ...extra });
    const joined = async (t: any, client: any, orgId: any, role: "admin" | "member", tokenIdentifier: string) => {
      const invite = await client.mutation(api.invites.create, { orgId, role });
      const user = t.withIdentity({ tokenIdentifier, name: role });
      await user.mutation(api.users.store, {});
      await user.mutation(api.invites.accept, { token: invite.token });
      return userId(t, tokenIdentifier);
    };
    const userId = (t: any, tokenIdentifier: string) => t.run(async (ctx: any) => (await ctx.db.query("users").withIndex("by_token", (q: any) => q.eq("tokenIdentifier", tokenIdentifier)).unique())._id);
    const writes = (t: any) => t.run(async (ctx: any) => ({ agents: (await ctx.db.query("agents").collect()).length, grants: (await ctx.db.query("capabilityGrants").collect()).length, audit: (await ctx.db.query("authorityAudit").collect()).length }));

    it("issues the intake grants as the named owner, so the key submits leads and nothing else", async () => {
      const { t, orgId } = await userAndOrg();
      const owner = await userId(t, "clerk|A");
      await cli(t, orgId, owner);
      const grants: any[] = await t.run((ctx: any) => ctx.db.query("capabilityGrants").collect());
      expect(grants.map((g) => g.grantor.id)).toEqual(Array(4).fill(owner));
      expect((await post(t, key, "/api/v1/intake/lead", lead, "cli-1")).status).toBe(201);
      const call = rest(t, key);
      expect((await call("GET", "/api/v1/records?object=person")).status).toBe(403);
      expect((await call("POST", "/api/v1/changes", { action: "create", object: "person", values: { name: "x" }, reason: "x" })).status).toBe(403);
    });

    it("refuses an admin who is not the owner, writing nothing", async () => {
      const { t, client, orgId } = await userAndOrg();
      const admin = await joined(t, client, orgId, "admin", "clerk|admin");
      const before = await writes(t);
      await expect(cli(t, orgId, admin)).rejects.toThrow(/owner/i);
      expect(await writes(t)).toEqual(before);
    });

    it("refuses an owner of a different workspace, writing nothing", async () => {
      const { t, orgId } = await userAndOrg();
      const other = t.withIdentity({ tokenIdentifier: "clerk|B", name: "B" });
      await other.mutation(api.users.store, {});
      await other.mutation(api.orgs.create, { name: "B Org" });
      const before = await writes(t);
      await expect(cli(t, orgId, await userId(t, "clerk|B"))).rejects.toThrow();
      expect(await writes(t)).toEqual(before);
    });

    it("refuses a second key with the same hash, writing nothing and leaving the first key working", async () => {
      const { t, orgId } = await userAndOrg();
      const owner = await userId(t, "clerk|A");
      await cli(t, orgId, owner);
      const before = await writes(t);
      await expect(cli(t, orgId, owner)).rejects.toThrow(/CONFLICT/);
      expect(await writes(t)).toEqual(before);
      expect((await post(t, key, "/api/v1/intake/lead", lead, "dup-1")).status).toBe(201);
    });

    it("refuses a key hash that is not 64 lowercase hex characters, or an empty prefix, writing nothing", async () => {
      const { t, orgId } = await userAndOrg();
      const owner = await userId(t, "clerk|A");
      const before = await writes(t);
      for (const extra of [{ keyHash: "not-a-hash" }, { keyHash: "A".repeat(64) }, { keyHash: "a".repeat(63) }, { keyPrefix: "" }]) await expect(cli(t, orgId, owner, extra)).rejects.toThrow(/VALIDATION/);
      expect(await writes(t)).toEqual(before);
    });

    it("refuses a plain member creating a normal key from the CLI, writing nothing", async () => {
      const { t, client, orgId } = await userAndOrg();
      const member = await joined(t, client, orgId, "member", "clerk|member");
      const before = await writes(t);
      await expect(cli(t, orgId, member, { intake: false, name: "cli key" })).rejects.toThrow(/Admin membership required/);
      await expect(cli(t, orgId, member, { intake: false, scoped: false, name: "cli key" })).rejects.toThrow(/Admin membership required/);
      expect(await writes(t)).toEqual(before);
    });

    it("stays internal, so clients cannot call it", () => {
      expect((insert as any).isInternal).toBe(true);
      expect((insert as any).isPublic).toBeFalsy();
    });
  });
});

describe("intake abuse limits", () => {
  const notices = (t: any) => t.run(async (ctx: any) => (await ctx.db.query("opsNotices").collect()).map((n: any) => n.payload));

  it("limits a burst from one key, writes nothing over the limit, and alerts the operator once", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const { t, orgId, send } = await intakeSetup();
    for (let i = 0; i < 10; i++) expect((await send({ name: `Lead ${i}`, email: `lead${i}@x.com` }, `burst-${i}`)).status).toBe(201);
    const before = await counts(t);
    const limited = await send({ name: "Lead 10", email: "lead10@x.com" }, "burst-10");
    expect(limited.status).toBe(429);
    expect(limited.json.error.code).toBe("RATE_LIMITED");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await send({ name: "Lead 11", email: "lead11@x.com" }, "burst-11")).status).toBe(429);
    expect(await counts(t)).toEqual(before);
    const alerts = await notices(t);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ source: "remold", event: "open", kind: "intake-limit", key: `intake-limit:${orgId}:key` });
    expect(JSON.stringify(alerts)).not.toContain("lead10@x.com");
  });

  it("limits repeated leads for one email", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const { t, send } = await intakeSetup();
    for (let i = 0; i < 3; i++) expect((await send({ name: "Same", email: i % 2 ? "SAME@x.com" : "same@x.com" }, `same-${i}`)).status).toBe(201);
    const before = await counts(t);
    expect((await send({ name: "Same", email: "same@x.com " }, "same-3")).status).toBe(429);
    expect((await send({ name: "Other", email: "other@x.com" }, "other")).status).toBe(201);
    expect((await counts(t)).opportunity).toBe(before.opportunity + 1);
  });

  it("caps leads per workspace per day from REMOLD_INTAKE_DAILY_CAP", async () => {
    vi.stubEnv("REMOLD_INTAKE_DAILY_CAP", "2");
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const { t, orgId, send } = await intakeSetup();
    expect((await send({ name: "A", email: "a@x.com" }, "1")).status).toBe(201);
    expect((await send({ name: "B", email: "b@x.com" }, "2")).status).toBe(201);
    expect((await send({ name: "C", email: "c@x.com" }, "3")).status).toBe(429);
    expect((await counts(t)).opportunity).toBe(2);
    expect((await notices(t)).map((n: any) => n.key)).toEqual([`intake-limit:${orgId}:daily`]);
    // A replay of a lead that already landed is not a new lead and is not capped.
    expect((await send({ name: "A", email: "a@x.com" }, "1")).status).toBe(201);
  });

  for (const [label, raw] of [["missing", undefined], ["empty", " "], ["not a number", "abc"], ["negative", "-1"], ["fractional", "1.5"], ["zero", "0"]] as const) {
    it(`takes no leads when REMOLD_INTAKE_DAILY_CAP is ${label}: a missing or unreadable cap means zero`, async () => {
      vi.stubEnv("REMOLD_INTAKE_DAILY_CAP", raw);
      const { t, send } = await intakeSetup();
      const before = await counts(t);
      const refused = await send({ name: "A", email: "a@x.com" }, `cap-${label.replace(/ /g, "-")}`);
      expect(refused.status).toBe(429);
      expect(refused.json.error.code).toBe("RATE_LIMITED");
      expect(await counts(t)).toEqual(before);
    });
  }

  it("counts the daily cap per UTC day: enforced all day, reset at midnight", async () => {
    vi.stubEnv("REMOLD_INTAKE_DAILY_CAP", "2");
    // Without an anchored window the limiter picks a random offset; pin it so an unanchored window would reset at 12:14 UTC.
    const random = Math.random.bind(Math);
    vi.spyOn(Math, "random").mockImplementation(() => new Error().stack?.includes("calculateRateLimit") ? 0.99 : random());
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-02T12:00:00Z"));
    const { t, send } = await intakeSetup();
    expect((await send({ name: "A", email: "a@x.com" }, "d1")).status).toBe(201);
    expect((await send({ name: "B", email: "b@x.com" }, "d2")).status).toBe(201);
    expect((await send({ name: "C", email: "c@x.com" }, "d3")).status).toBe(429);
    clock.mockReturnValue(Date.parse("2026-10-02T12:15:00Z"));
    expect((await send({ name: "D", email: "d@x.com" }, "d4")).status).toBe(429);
    clock.mockReturnValue(Date.parse("2026-10-02T23:59:59Z"));
    expect((await send({ name: "E", email: "e@x.com" }, "d5")).status).toBe(429);
    clock.mockReturnValue(Date.parse("2026-10-03T00:00:01Z"));
    expect((await send({ name: "F", email: "f@x.com" }, "d6")).status).toBe(201);
    expect((await counts(t)).opportunity).toBe(3);
  });
});

describe("applyChange write-only path", () => {
  // Called directly, so this guards applyChange itself and not only submitLead's own grant check.
  const writeOnly = async (t: any, agentId: any, orgId: any, objectKey: string, values: Record<string, string>) => t.run(async (ctx: any) => {
    const principal = await requireAgent(ctx, (await ctx.db.get(agentId)).keyHash, "intake");
    const object = (await ctx.db.query("objects").collect()).find((o: any) => o.orgId === orgId && o.key === objectKey);
    const fields = await ctx.db.query("fields").withIndex("by_object", (q: any) => q.eq("orgId", orgId).eq("objectId", object._id)).collect();
    const ids = Object.fromEntries(Object.entries(values).map(([key, value]) => [fields.find((f: any) => f.key === key)._id, value]));
    return applyChange(ctx, principal, { action: "create", orgId, objectId: object._id, values: ids, reason: "test" }, { writeOnly: true });
  });

  it("writes fields the intake key holds a direct field grant for", async () => {
    const { t, orgId, intake } = await intakeSetup();
    expect((await writeOnly(t, intake.agentId, orgId, "person", { name: "Granted" })).recordId).toBeTruthy();
  });

  it("refuses a field outside the intake key's field grants, and an object it has no grant on", async () => {
    const { t, orgId, intake } = await intakeSetup();
    const before = await counts(t);
    await expect(writeOnly(t, intake.agentId, orgId, "person", { name: "X", title: "CEO" })).rejects.toThrow(/Direct field grant required/);
    await expect(writeOnly(t, intake.agentId, orgId, "task", { title: "X" })).rejects.toThrow(/Direct field grant required/);
    expect(await counts(t)).toEqual(before);
  });

  it("refuses a signed-in member, who has no field grants", async () => {
    const { t, orgId } = await userAndOrg();
    await expect(t.run(async (ctx: any) => {
      const member = (await ctx.db.query("members").collect()).find((m: any) => m.orgId === orgId);
      const principal = { user: await ctx.db.get(member.userId), actor: { kind: "user" as const, id: member.userId }, member, org: await ctx.db.get(orgId) };
      const person = (await ctx.db.query("objects").collect()).find((o: any) => o.orgId === orgId && o.key === "person");
      const name = (await ctx.db.query("fields").withIndex("by_object", (q: any) => q.eq("orgId", orgId).eq("objectId", person._id)).collect()).find((f: any) => f.key === "name");
      return applyChange(ctx, principal, { action: "create", orgId, objectId: person._id, values: { [name._id]: "Member" }, reason: "test" }, { writeOnly: true });
    })).rejects.toThrow(/Direct field grant required/);
  });
});
