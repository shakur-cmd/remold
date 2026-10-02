import { afterEach, describe, expect, it, vi } from "vitest";
import { agentFor, api, objectFields, rest, userAndOrg } from "./test.helpers";

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

  it("falls back to the phone number and fills only empty person fields", async () => {
    const { t, client, orgId, send } = await intakeSetup();
    const person = await objectFields(client, orgId, "person");
    const existing = await client.mutation(api.records.create, { orgId, objectId: person.object._id, values: { [person.fields.name._id]: "Original Name", [person.fields.phone._id]: "+14105550100", [person.fields.title._id]: "Owner", [person.fields.email._id]: "old@x.com" } });
    await send({ name: "Changed Name", email: "new@x.com", phone: "+1 410 555 0100", company: "Acme" }, "c");
    expect((await counts(t)).person).toBe(1);
    const record = (await client.query(api.records.get, { orgId, recordId: existing.recordId }))!.record;
    expect(record.values[person.fields.name._id]).toBe("Original Name");
    expect(record.values[person.fields.title._id]).toBe("Owner");
    expect(record.values[person.fields.email._id]).toBe("old@x.com");
    expect(record.values[person.fields.company._id]).toBeTruthy();
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

  it("reuses a company with the same name", async () => {
    const { t, client, orgId, send } = await intakeSetup();
    const company = await objectFields(client, orgId, "company");
    await client.mutation(api.records.create, { orgId, objectId: company.object._id, values: { [company.fields.name._id]: "CodeMyVibe" } });
    await send({ ...lead, company: "codemyvibe " }, "e");
    expect((await counts(t)).company).toBe(1);
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
});

describe("intake abuse limits", () => {
  const notices = (t: any) => t.run(async (ctx: any) => (await ctx.db.query("opsNotices").collect()).map((n: any) => n.payload));

  it("limits a burst from one key, writes nothing over the limit, and alerts the operator once", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const { t, send } = await intakeSetup();
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
    expect(alerts[0]).toMatchObject({ source: "remold", event: "open", kind: "intake-limit" });
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
    const { t, send } = await intakeSetup();
    expect((await send({ name: "A", email: "a@x.com" }, "1")).status).toBe(201);
    expect((await send({ name: "B", email: "b@x.com" }, "2")).status).toBe(201);
    expect((await send({ name: "C", email: "c@x.com" }, "3")).status).toBe(429);
    expect((await counts(t)).opportunity).toBe(2);
    expect((await notices(t)).map((n: any) => n.key)).toEqual(["intake-limit:daily"]);
    // A replay of a lead that already landed is not a new lead and is not capped.
    expect((await send({ name: "A", email: "a@x.com" }, "1")).status).toBe(201);
  });
});
