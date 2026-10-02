import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { anyApi } from "convex/server";
import schema from "./schema";
import { agentFor, api, bulk, objectFields, rest, userAndOrg } from "./test.helpers";
import { internal } from "./_generated/api";
import { canonical, MAX_ROWS } from "./workspace";
import { principalFor } from "./authority/grants";

// Replaces every id with the order it first appears in, so two exports compare by shape and links, not by id.
function modIds(data: any) {
  const seen = new Map<string, string>();
  const ids = new Set<string>([...data.objects, ...data.fields, ...data.records, ...data.events].map((row: any) => row.id));
  for (const event of data.events) ids.add(event.record);
  const walk = (value: any): any => typeof value === "string" ? (ids.has(value) ? (seen.get(value) ?? (seen.set(value, `#${seen.size}`), `#${seen.size - 1}`)) : value) : Array.isArray(value) ? value.map(walk) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)])) : value;
  const { sha256, ...rest } = data;
  return walk(rest);
}

async function filled(name: string, f?: Awaited<ReturnType<typeof userAndOrg>>) {
  f ??= await userAndOrg(name);
  const { client, orgId } = f;
  const company = await objectFields(client, orgId, "company"), person = await objectFields(client, orgId, "person"), task = await objectFields(client, orgId, "task");
  const vendorId = await client.mutation(api.objects.create, { orgId, key: "vendor", label: "Vendor", labelPlural: "Vendors" });
  const { fieldId: rating } = await client.mutation(api.fields.create, { orgId, objectId: vendorId, key: "rating", label: "Rating", type: "number" });
  const { fieldId: supplier } = await client.mutation(api.fields.create, { orgId, objectId: vendorId, key: "supplier", label: "Supplier", type: "lookup", targetObjectId: company.object._id });
  await client.mutation(api.fields.update, { orgId, fieldId: company.fields.city._id, label: "Town" });
  await client.mutation(api.fields.retire, { orgId, fieldId: company.fields.street._id });
  const acme = (await client.mutation(api.records.create, { orgId, objectId: company.object._id, values: { [company.fields.name._id]: `${name} Acme`, [company.fields.city._id]: "Leeds" } })).recordId;
  const ann = (await client.mutation(api.records.create, { orgId, objectId: person.object._id, values: { [person.fields.name._id]: `${name} Ann`, [person.fields.company._id]: acme } })).recordId;
  const gone = (await client.mutation(api.records.create, { orgId, objectId: person.object._id, values: { [person.fields.name._id]: `${name} Gone` } })).recordId;
  await client.mutation(api.records.update, { orgId, recordId: ann, values: { [person.fields.email._id]: "ann@example.invalid" } });
  await client.mutation(api.records.remove, { orgId, recordId: gone });
  const t2 = (await client.mutation(api.records.create, { orgId, objectId: task.object._id, values: { [task.fields.title._id]: `${name} second`, [task.fields.dueDate._id]: Date.UTC(2026, 9, 2, 14, 30) } })).recordId;
  await client.mutation(api.records.create, { orgId, objectId: task.object._id, values: { [task.fields.title._id]: `${name} first`, [task.fields.blockedBy._id]: [t2], [task.fields.about._id]: ann, [task.fields.done._id]: false } });
  await client.mutation(api.records.create, { orgId, objectId: vendorId, values: { [(await objectFields(client, orgId, "vendor")).fields.name._id]: `${name} Vendor`, [rating]: 4, [supplier]: acme } });
  return { ...f, acme, ann, t2, person, task, company };
}
async function second(t: any, name = "B") {
  const client = t.withIdentity({ tokenIdentifier: `clerk|${name}`, name });
  await client.mutation(api.users.store, {});
  return client;
}
async function joinAs(a: any, client: any, role: "admin" | "member") {
  const invite = await a.client.mutation(api.invites.create, { orgId: a.orgId, role });
  await client.mutation(api.invites.accept, { token: invite.token });
}
const exportOf = (client: any, orgId: any): Promise<any> => client.query(api.workspace.exportAll, { orgId });

// convex-test simulates 15,000-row reads and writes in memory; these two need more than the default 15 s.
const HEAVY = 60_000;
const ownerOnly = { data: { code: "FORBIDDEN" } };
const refused = (why: RegExp) => ({ data: { code: "VALIDATION", message: expect.stringMatching(why) } });
afterEach(() => { vi.useRealTimers(); });

describe("full workspace export", () => {
  it("writes definitions, records keyed by field key, links by record id and the whole history", async () => {
    const a = await filled("A");
    const data = await exportOf(a.client, a.orgId);
    expect(data).toMatchObject({ format: "remold.workspace", version: 1, workspace: { name: "A Org" } });
    expect(data.objects.map((o: any) => o.key)).toContain("vendor");
    expect(data.fields).toContainEqual(expect.objectContaining({ key: "city", label: "Town" }));
    expect(data.fields).toContainEqual(expect.objectContaining({ key: "street", retired: true }));
    const ann = data.records.find((r: any) => r.id === a.ann);
    expect(ann.values).toEqual({ name: "A Ann", company: a.acme, email: "ann@example.invalid" });
    const first = data.records.find((r: any) => r.values.title === "A first");
    expect(first.values).toMatchObject({ blockedBy: [a.t2], about: a.ann, done: false });
    expect(data.events.map((e: any) => e.action)).toEqual(["create", "create", "create", "update", "delete", "create", "create", "create"]);
    expect(data.events.find((e: any) => e.action === "update")).toMatchObject({ record: a.ann, by: "A", before: { email: null }, after: { email: "ann@example.invalid" } });
    expect(data.events.find((e: any) => e.action === "delete").before).toEqual({ name: "A Gone" });
    expect(data.events.every((e: any) => typeof e.at === "number")).toBe(true);
    const { sha256, ...body } = data;
    expect(sha256).toBe(createHash("sha256").update(canonical(JSON.parse(JSON.stringify(body)))).digest("hex"));
  });

  it("contains nothing from another workspace and is refused to anyone but an unrestricted owner", async () => {
    const a = await filled("A");
    const b = await second(a.t);
    const orgB = await b.mutation(api.orgs.create, { name: "B Org" });
    const company = await objectFields(b, orgB, "company");
    const secret = (await b.mutation(api.records.create, { orgId: orgB, objectId: company.object._id, values: { [company.fields.name._id]: "B secret" } })).recordId;
    const text = JSON.stringify(await exportOf(a.client, a.orgId));
    for (const leak of ["B secret", secret, orgB, company.object._id]) expect(text).not.toContain(leak);
    await expect(exportOf(b, a.orgId)).rejects.toMatchObject(ownerOnly);
    await joinAs(a, b, "admin");
    await expect(exportOf(b, a.orgId)).rejects.toMatchObject(ownerOnly);
  });

  it("Export is refused to an owner with hidden fields or record scopes", async () => {
    const a = await filled("A");
    const before = await exportOf(a.client, a.orgId);
    const memberId = await a.t.run(async (ctx: any) => (await ctx.db.query("members").collect())[0]._id);
    await a.client.mutation(anyApi["authority/policies"].setMember, { orgId: a.orgId, memberId, hiddenFieldIds: [a.company.fields.city._id] });
    await expect(exportOf(a.client, a.orgId)).rejects.toMatchObject(ownerOnly);
    await expect(a.client.mutation(api.workspace.confirmDelete, { orgId: a.orgId, confirmName: "A Org", sha256: before.sha256 })).rejects.toMatchObject(ownerOnly);
  });

  it("exports and re-imports a workspace exactly at the size limit; above it, deletion needs DELETE WITHOUT EXPORT", async () => {
    const a = await userAndOrg("A");
    const note = await objectFields(a.client, a.orgId, "note");
    const small = await exportOf(a.client, a.orgId);
    expect(MAX_ROWS).toBe(15000);
    const room = MAX_ROWS - small.objects.length - small.fields.length;
    const add = (n: number) => a.t.run(async (ctx: any) => { const user = (await ctx.db.query("users").first())._id; for (let i = 0; i < n; i++) await ctx.db.insert("records", { orgId: a.orgId, objectId: note.object._id, values: { [note.fields.body._id]: `n${i}` }, title: `n${i}`, createdBy: user, updatedAt: 0 }); });
    await add(room);
    const full = await exportOf(a.client, a.orgId);
    expect(full.records).toHaveLength(room);
    const fresh = await a.client.mutation(api.orgs.create, { name: "Copy" });
    await a.client.mutation(api.workspace.importAll, { orgId: fresh, data: full });
    expect((await exportOf(a.client, fresh)).records).toHaveLength(room);
    // The phrase is refused while an export is still possible.
    await expect(a.client.mutation(api.workspace.confirmDelete, { orgId: a.orgId, confirmName: "A Org", withoutExport: "DELETE WITHOUT EXPORT" })).rejects.toMatchObject(refused(/export it first/));
    await add(1);
    await expect(exportOf(a.client, a.orgId)).rejects.toMatchObject(refused(/more than 15,000 rows/));
    await expect(a.client.mutation(api.workspace.importAll, { orgId: await a.client.mutation(api.orgs.create, { name: "Too big" }), data: { ...full, records: [...full.records, { ...full.records[0], id: "extra" }] } })).rejects.toMatchObject(refused(/more than 15,000 rows/));
    for (const withoutExport of ["delete without export", "DELETE"]) await expect(a.client.mutation(api.workspace.confirmDelete, { orgId: a.orgId, confirmName: "A Org", withoutExport })).rejects.toMatchObject(refused(/DELETE WITHOUT EXPORT/));
    await expect(a.client.mutation(api.workspace.confirmDelete, { orgId: a.orgId, confirmName: "A org", withoutExport: "DELETE WITHOUT EXPORT" })).rejects.toMatchObject(refused(/name exactly/));
    vi.useFakeTimers();
    await a.client.mutation(api.workspace.confirmDelete, { orgId: a.orgId, confirmName: "A Org", withoutExport: "DELETE WITHOUT EXPORT" });
    await expect(a.client.query(api.orgs.get, { orgId: a.orgId })).rejects.toMatchObject(ownerOnly);
    await a.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await a.t.run(async (ctx: any) => (await ctx.db.query("records").collect()).filter((r: any) => r.orgId === a.orgId).length)).toBe(0);
  }, HEAVY);

  it("counts relation values toward the limit on import too", async () => {
    const a = await filled("A");
    const data = await exportOf(a.client, a.orgId);
    data.records.find((r: any) => r.values.title === "A first").values.blockedBy = Array(MAX_ROWS).fill(a.t2);
    const fresh = await a.client.mutation(api.orgs.create, { name: "Fresh" });
    await expect(a.client.mutation(api.workspace.importAll, { orgId: fresh, data })).rejects.toMatchObject(refused(/more than 15,000 rows/));
  });

  it("exports and restores a realistic workspace of 3,000 people with their history", async () => {
    const a = await userAndOrg("A");
    const person = await objectFields(a.client, a.orgId, "person"), company = await objectFields(a.client, a.orgId, "company");
    await bulk(a.t, a.orgId, async (apply) => {
      const companies = [];
      for (let i = 0; i < 50; i++) companies.push((await apply({ action: "create", objectId: company.object._id, values: { [company.fields.name._id]: `Company ${i}` } })).recordId);
      for (let i = 0; i < 3000; i++) await apply({ action: "create", objectId: person.object._id, values: { [person.fields.name._id]: `Person ${i}`, [person.fields.email._id]: `p${i}@example.invalid`, [person.fields.company._id]: companies[i % 50] } });
    });
    const data = await exportOf(a.client, a.orgId);
    expect(data.records).toHaveLength(3050);
    expect(data.events).toHaveLength(3050);
    const fresh = await a.client.mutation(api.orgs.create, { name: "A Org" });
    await a.client.mutation(api.workspace.importAll, { orgId: fresh, data });
    expect(modIds(await exportOf(a.client, fresh))).toEqual(modIds(data));
  }, HEAVY);
});

describe("workspace import", () => {
  it("restores an export into a fresh workspace with new ids, links intact, and re-exports the same", async () => {
    const a = await filled("A");
    const original = await exportOf(a.client, a.orgId);
    const fresh = await a.client.mutation(api.orgs.create, { name: "A Org" });
    await a.client.mutation(api.workspace.importAll, { orgId: fresh, data: original });
    const again = await exportOf(a.client, fresh);
    expect(again.records.map((r: any) => r.id)).not.toContain(a.ann);
    expect(modIds(again)).toEqual(modIds(original));
    const person = await objectFields(a.client, fresh, "person");
    const ann = again.records.find((r: any) => r.values.name === "A Ann");
    const read: any = await a.client.query(api.records.get, { orgId: fresh, recordId: ann.id });
    expect(read.record.values[person.fields.company._id]).toBe(again.records.find((r: any) => r.values.name === "A Acme").id);
    const links = (orgId: any) => a.t.run(async (ctx: any) => (await ctx.db.query("links").collect()).filter((l: any) => l.orgId === orgId).length);
    expect(await links(a.orgId)).toBe(1);
    expect(await links(fresh)).toBe(1);
    const second = again.records.find((r: any) => r.values.title === "A second");
    expect((await a.client.query(api.records.related, { orgId: fresh, recordId: second.id, fieldId: (await objectFields(a.client, fresh, "task")).fields.blockedBy._id, paginationOpts: { cursor: null, numItems: 10 } })).page.map((r: any) => r.title)).toEqual(["A first"]);
    const history = await a.client.query(api.events.forRecord, { orgId: fresh, recordId: ann.id });
    expect(history.map((e: any) => [e.action, e.actorName])).toEqual([["update", "A"], ["create", "A"]]);
  });

  it("refuses a workspace that already has records, and refuses non-owners", async () => {
    const a = await filled("A");
    const data = await exportOf(a.client, a.orgId);
    await expect(a.client.mutation(api.workspace.importAll, { orgId: a.orgId, data })).rejects.toMatchObject(refused(/no records/));
    const b = await second(a.t);
    const fresh = await a.client.mutation(api.orgs.create, { name: "Fresh" });
    await expect(b.mutation(api.workspace.importAll, { orgId: fresh, data })).rejects.toMatchObject(ownerOnly);
    await expect(a.client.mutation(api.workspace.importAll, { orgId: fresh, data: { ...data, version: 99 } })).rejects.toMatchObject(refused(/version 1/));
    // A member's mask names field ids that import would replace.
    const masked = await a.t.run(async (ctx: any) => { const field = (await ctx.db.query("fields").collect()).find((f: any) => f.orgId === fresh); return ctx.db.insert("members", { orgId: fresh, userId: await ctx.db.insert("users", { tokenIdentifier: "clerk|C", name: "C" }), role: "member", hiddenFieldIds: [field._id] }); });
    await expect(a.client.mutation(api.workspace.importAll, { orgId: fresh, data })).rejects.toMatchObject(refused(/restrictions/));
    await a.t.run(async (ctx: any) => ctx.db.delete(masked));
    await a.t.run(async (ctx: any) => ctx.db.patch(fresh, { flags: { readonly: true } }));
    await expect(a.client.mutation(api.workspace.importAll, { orgId: fresh, data })).rejects.toMatchObject({ data: { code: "FORBIDDEN", message: "Workspace is read only" } });
  });

  it("rejects unknown fields, duplicate ids or keys and bad relations with the reason, and writes nothing", async () => {
    const a = await filled("A");
    const good = await exportOf(a.client, a.orgId);
    const fresh = await a.client.mutation(api.orgs.create, { name: "Fresh" });
    const rows = () => a.t.run(async (ctx: any) => { const out: Record<string, number> = {}; for (const table of Object.keys(schema.tables)) out[table] = (await ctx.db.query(table).collect()).filter((r: any) => r.orgId === fresh).length; return out; });
    const before = await rows();
    const copy = () => structuredClone(good);
    const ann = (d: any) => d.records.find((r: any) => r.id === a.ann);
    const cases: [string, (d: any) => void, RegExp][] = [
      ["unknown field", d => { ann(d).values.nickname = "MUST NOT DISAPPEAR"; }, /unknown field "nickname"/],
      ["unknown property", d => { d.events[0].actor = { kind: "agent", id: "x" }; }, /unknown property "actor"/],
      ["duplicate record id", d => { d.records.push({ ...d.records[0] }); }, /duplicate record id/],
      ["duplicate object key", d => { d.objects.push({ ...d.objects[0], id: "other" }); }, /duplicate object key/],
      ["duplicate field key", d => { d.fields.push({ ...d.fields[0], id: "other" }); }, /duplicate field key/],
      ["relation to a missing record", d => { ann(d).values.company = "no-such-record"; }, /invalid relation in "company"/],
      ["relation to the wrong object", d => { ann(d).values.company = a.ann; }, /invalid relation in "company"/],
      ["bad value", d => { ann(d).values.email = 42; }, /invalid value in "email"/],
      ["bad select option", d => { d.records.find((r: any) => r.values.title === "A first").values.done = "yes"; }, /invalid value in "done"/],
      ["event that does not match its action", d => { d.events[0].before = {}; }, /does not match its action/],
    ];
    for (const [name, corrupt, why] of cases) {
      const data = copy(); corrupt(data);
      await expect(a.client.mutation(api.workspace.importAll, { orgId: fresh, data }), name).rejects.toMatchObject(refused(why));
    }
    expect(await rows()).toEqual(before);
    await a.client.mutation(api.workspace.importAll, { orgId: fresh, data: good });
    expect((await exportOf(a.client, fresh)).records).toHaveLength(good.records.length);
  });

  it("lets only one of two simultaneous imports into the same workspace through", async () => {
    const a = await filled("A");
    const data = await exportOf(a.client, a.orgId);
    const fresh = await a.client.mutation(api.orgs.create, { name: "Fresh" });
    const results = await Promise.allSettled([1, 2].map(() => a.client.mutation(api.workspace.importAll, { orgId: fresh, data })));
    expect(results.map(r => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((results.find(r => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject(refused(/no records/));
    expect((await exportOf(a.client, fresh)).records).toHaveLength(data.records.length);
  });

  it("names history actors as text and never shows another workspace's agent", async () => {
    const a = await filled("A");
    const b = await second(a.t);
    const orgB = await b.mutation(api.orgs.create, { name: "B Org" });
    const { agentId } = await agentFor(b, orgB, { name: "CONFIDENTIAL B AGENT" });
    // An event in A that names B's agent by id, as older or hand-made data could.
    await a.t.run(async (ctx: any) => { const e = (await ctx.db.query("events").collect()).find((x: any) => x.orgId === a.orgId && x.recordId === a.ann); await ctx.db.insert("events", { ...e, _id: undefined, _creationTime: undefined, action: "update", before: e.after, actor: { kind: "agent", id: agentId } }); });
    const history = await a.client.query(api.events.forRecord, { orgId: a.orgId, recordId: a.ann });
    expect(JSON.stringify(history)).not.toContain("CONFIDENTIAL");
    expect(history[0].actorName).toBeNull();
    const data = await exportOf(a.client, a.orgId);
    expect(JSON.stringify(data)).not.toContain("CONFIDENTIAL");
    const fresh = await a.client.mutation(api.orgs.create, { name: "Fresh" });
    await a.client.mutation(api.workspace.importAll, { orgId: fresh, data });
    const stored = await a.t.run(async (ctx: any) => (await ctx.db.query("events").collect()).filter((e: any) => e.orgId === fresh).map((e: any) => e.actor));
    expect(stored.every((actor: any) => actor.kind === "imported" && typeof actor.name === "string" && !("id" in actor))).toBe(true);
  });

  it("keeps imported history in its original order next to later native activity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 0, 1, 10));
    const a = await userAndOrg("A");
    const person = await objectFields(a.client, a.orgId, "person");
    const ann = (await a.client.mutation(api.records.create, { orgId: a.orgId, objectId: person.object._id, values: { [person.fields.name._id]: "Ann" } })).recordId;
    vi.setSystemTime(Date.UTC(2026, 0, 2, 10));
    await a.client.mutation(api.records.update, { orgId: a.orgId, recordId: ann, values: { [person.fields.email._id]: "ann@example.invalid" } });
    const data = await exportOf(a.client, a.orgId);
    vi.setSystemTime(Date.UTC(2026, 5, 1, 10));
    const fresh = await a.client.mutation(api.orgs.create, { name: "Fresh" });
    await a.client.mutation(api.workspace.importAll, { orgId: fresh, data });
    const copy = (await exportOf(a.client, fresh)).records[0].id;
    const activity = await objectFields(a.client, fresh, "activity"), freshPerson = await objectFields(a.client, fresh, "person");
    await a.client.mutation(api.records.create, { orgId: fresh, objectId: activity.object._id, values: { [activity.fields.title._id]: "Call", [activity.fields.when._id]: Date.UTC(2026, 0, 1, 12), [activity.fields.about._id]: copy } });
    vi.setSystemTime(Date.UTC(2026, 5, 2, 10));
    await a.client.mutation(api.records.update, { orgId: fresh, recordId: copy, values: { [freshPerson.fields.phone._id]: "1" } });
    const page = await a.client.query(api.events.timeline, { orgId: fresh, recordId: copy, paginationOpts: { cursor: null, numItems: 2 } });
    const rest = await a.client.query(api.events.timeline, { orgId: fresh, recordId: copy, paginationOpts: { cursor: page.continueCursor, numItems: 10 } });
    const rows = [...page.page, ...rest.page].map((e: any) => [e.kind === "event" ? e.action : e.kind, new Date(e.at).toISOString().slice(0, 13)]);
    expect(rows).toEqual([["update", "2026-06-02T10"], ["update", "2026-01-02T10"], ["activity", "2026-01-01T12"], ["create", "2026-01-01T10"]]);
  });
});

// Every table whose rows carry an orgId, from the schema itself, so a new per-workspace table must be covered.
const orgTables = Object.entries(schema.tables).filter(([, table]: any) => "orgId" in table.validator.fields).map(([name]) => name);

async function seedEverywhere(t: any, orgId: any) {
  await t.run(async (ctx: any) => {
    const member = (await ctx.db.query("members").collect()).find((m: any) => m.orgId === orgId);
    const object = (await ctx.db.query("objects").collect()).find((o: any) => o.orgId === orgId);
    const agentId = await ctx.db.insert("agents", { orgId, name: "bot", role: "member", createdBy: member.userId, keyHash: `h${orgId}`, keyPrefix: "rm_", grants: [] });
    const actor = { kind: "user", id: member.userId };
    await ctx.db.insert("capabilityGrants", { orgId, agentId, grantor: actor, grantorEpoch: 0, capability: "read", scope: { kind: "records", objectId: object._id, records: "all", fields: [] }, mode: "propose", delegate: false, expiresAt: Date.now() + 1e9 });
    await ctx.db.insert("invites", { orgId, token: `tok${orgId}`, role: "member", createdBy: member.userId, expiresAt: Date.now() + 1e9 });
    await ctx.db.insert("authorityAudit", { orgId, actor, action: "test", targetId: "x" });
    await ctx.db.insert("opsEvents", { orgId, actor: { kind: "operator", id: "internal-admin" }, action: "featureFlagChanged", flag: "f", before: false, after: true, reason: "test" });
    await ctx.db.insert("billingEvents", { orgId, eventId: `evt_${orgId}`, type: "customer.subscription.updated", created: 1, to: "active", from: "none" });
    const suggestion = await ctx.db.insert("suggestions", { orgId, agentId, status: "pending", change: { action: "create", objectId: object._id, values: {} }, before: {}, reason: "r" });
    await ctx.db.insert("agentInbox", { orgId, text: "hi", source: "test", from: { kind: "agent", id: agentId }, status: "pending", suggestionId: suggestion });
    const secret = await ctx.db.insert("secretReferences", { orgId, provider: "p", environment: "test", account: `a${orgId}`, handle: "h", version: 1, active: true });
    const connectionId = await ctx.db.insert("integrationConnections", { orgId, provider: "p", environment: "test", account: `a${orgId}`, secretReferenceId: secret, credentialHash: `c${orgId}`, connected: true, healthy: true, version: 1 });
    const bindingId = await ctx.db.insert("integrationBindings", { orgId, connectionId, provider: "p", environment: "test", account: `a${orgId}`, kind: "k", externalId: "e", connected: true });
    await ctx.db.insert("integrationIntents", { orgId, connectionId, logical: "l", kind: "k", desired: "present", cleanupRequired: false });
    await ctx.db.insert("integrationCallbacks", { orgId, bindingId, eventId: "ev", digest: "d", receivedAt: 1 });
    await ctx.db.insert("integrationObservations", { orgId, bindingId, version: 1, state: "s", observedAt: 1 });
    const cursorId = await ctx.db.insert("integrationCursors", { orgId, connectionId, resource: "r", checkpoint: 0, traversal: "t", nextPage: 0, complete: false });
    await ctx.db.insert("integrationPages", { cursorId, traversal: "t", page: 0, digest: "d" });
    const lookupId = await ctx.db.insert("integrationLookups", { orgId, connectionId, cursorId, resource: "r", traversal: "t", pageCount: 0, digest: "d", completedAt: 1 });
    const targetId = await ctx.db.insert("safetyTargets", { orgId, bindingId, documentRef: "doc", providerRef: "pr", kind: "payment", currency: "usd", paidMinor: 0, refundedMinor: 0, pendingRefundMinor: 0, cancelled: false, generation: 0, startedAt: 1, complete: false, providerPendingMinor: 0, lookupId });
    await ctx.db.insert("integrationReceipts", { orgId, targetId, provider: "p", environment: "test", account: "a", kind: "refund", receipt: { receiptId: `r${orgId}`, sourceRef: "s", status: "pending", amountMinor: 1, currency: "usd" } });
    await ctx.db.insert("consent", { orgId, recipient: "x@example.invalid", channel: "email", purpose: "p", suppressed: false, source: "s", version: 1, at: 1 });
    await ctx.db.insert("usageBudgets", { key: orgId, orgId, cap: 0, maxConcurrent: 0, maxPerRun: 0, maxSteps: 0, maxRecipients: 0, reserved: 0, active: 0, spent: 0, missingUsage: false, missingUsageCount: 0 });
    const operationId = await ctx.db.insert("integrationOps", { orgId, actor, owner: actor, author: actor, actorEpoch: 0, capability: "marketing.send", logical: "l", bindingId, payload: { content: "", audience: [], audienceVersion: 0, destination: "", schedule: 0, amountMinor: 0, currency: "usd", workflowVersion: 0 }, version: 1, state: "proposed", reservationUnits: 0, reserved: 0, usage: 0, usageMissing: false, step: 0, maxSteps: 1, fence: 0, leaseUntil: 0, permitUntil: 0, permitUsed: false, attempts: 0, released: false, overrun: false, late: false, consumedPermits: [], receipts: [] });
    await ctx.db.insert("integrationEvents", { orgId, operationId, actor, name: "n", at: 1 });
  });
}

async function counts(t: any, orgId: string): Promise<Record<string, number>> {
  return t.run(async (ctx: any) => {
    const out: Record<string, number> = {};
    for (const name of Object.keys(schema.tables)) out[name] = (await ctx.db.query(name).collect()).filter((row: any) => row.orgId === orgId || row._id === orgId).length;
    out.integrationPagesAll = (await ctx.db.query("integrationPages").collect()).length;
    out.usersAll = (await ctx.db.query("users").collect()).length;
    return out;
  });
}

describe("workspace deletion", () => {
  it("needs the owner, the exact name and the sha256 of the current export, then closes the workspace at once", async () => {
    const a = await filled("A");
    const agent = await agentFor(a.client, a.orgId, { name: "bot" });
    const b = await second(a.t);
    await joinAs(a, b, "admin");
    const stale = (await exportOf(a.client, a.orgId)).sha256;
    await a.client.mutation(api.records.update, { orgId: a.orgId, recordId: a.ann, values: { [a.person.fields.phone._id]: "2" } });
    const { sha256 } = await exportOf(a.client, a.orgId);
    const confirm = (client: any, args: any) => client.mutation(api.workspace.confirmDelete, { orgId: a.orgId, confirmName: "A Org", sha256, ...args });
    await expect(confirm(a.client, { confirmName: "A org" })).rejects.toMatchObject(refused(/name exactly/));
    await expect(confirm(a.client, { sha256: stale })).rejects.toMatchObject(refused(/export again/));
    await expect(confirm(a.client, { sha256: "0".repeat(64) })).rejects.toMatchObject(refused(/export again/));
    await expect(confirm(b, {})).rejects.toMatchObject(ownerOnly);
    expect((await a.client.query(api.orgs.get, { orgId: a.orgId })).name).toBe("A Org");
    const invite = await a.client.mutation(api.invites.create, { orgId: a.orgId, role: "member" });
    const reminderFor = await a.t.run(async (ctx: any) => { const m = (await ctx.db.query("members").collect()).find((x: any) => x.orgId === a.orgId && x.role === "owner"); await ctx.db.patch(m._id, { dailyReminder: true }); await ctx.db.patch(m.userId, { email: "a@example.invalid" }); return m._id; });
    vi.useFakeTimers();
    const before = await counts(a.t, a.orgId);
    await confirm(a.client, {});
    // Confirmation writes nothing but the marker; every row is still there and nobody can reach it.
    expect(await counts(a.t, a.orgId)).toEqual(before);
    await expect(a.client.query(api.orgs.get, { orgId: a.orgId })).rejects.toMatchObject(ownerOnly);
    await expect(b.query(api.records.get, { orgId: a.orgId, recordId: a.ann })).rejects.toMatchObject(ownerOnly);
    expect(await a.client.query(api.orgs.mine, {})).toEqual([]);
    expect((await rest(a.t, agent.key)("GET", "/api/v1/me")).status).toBe(401);
    const c = await second(a.t, "C");
    expect(await c.query(api.invites.get, { token: invite.token })).toBeNull();
    await expect(c.mutation(api.invites.accept, { token: invite.token })).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
    expect(await a.t.query(anyApi.reminders.compose, { memberId: reminderFor })).toBeNull();
    // Background work re-derives its principal and is refused too.
    const ownerId = (await a.client.query(api.users.me, {}))!._id;
    await expect(a.t.run((ctx: any) => principalFor(ctx, a.orgId, { kind: "user", id: ownerId }))).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
    // A principal read before the deletion started is refused when it is re-checked at the write.
    await expect(bulk(a.t, a.orgId, async (apply) => { await apply({ action: "update", recordId: a.ann, values: { [a.person.fields.phone._id]: "3" } }); })).rejects.toMatchObject({ data: { code: "FORBIDDEN", message: "Workspace no longer exists" } });
    await a.t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  it("removes every row of the workspace in batches and leaves the other workspace untouched", async () => {
    const a = await filled("A");
    const b = await second(a.t);
    const orgB = await b.mutation(api.orgs.create, { name: "B Org" });
    const company = await objectFields(b, orgB, "company");
    await b.mutation(api.records.create, { orgId: orgB, objectId: company.object._id, values: { [company.fields.name._id]: "B secret" } });
    await seedEverywhere(a.t, a.orgId); await seedEverywhere(a.t, orgB);
    // Enough records and members that no single step could finish the job.
    const many = await objectFields(a.client, a.orgId, "note");
    await a.t.run(async (ctx: any) => {
      const user = (await ctx.db.query("users").first())._id;
      for (let i = 0; i < 300; i++) await ctx.db.insert("records", { orgId: a.orgId, objectId: many.object._id, values: {}, title: `n${i}`, createdBy: user, updatedAt: 0 });
      for (let i = 0; i < 402; i++) await ctx.db.insert("members", { orgId: a.orgId, userId: await ctx.db.insert("users", { tokenIdentifier: `clerk|m${i}`, name: `m${i}` }), role: "member" });
    });
    // A read-only hold does not block leaving: deletion only removes.
    await a.t.run(async (ctx: any) => ctx.db.patch(a.orgId, { flags: { readonly: true } }));
    const beforeA = await counts(a.t, a.orgId), beforeB = await counts(a.t, orgB);
    for (const name of orgTables) expect(beforeA[name], `fixture must seed ${name}`).toBeGreaterThan(0);
    vi.useFakeTimers();
    const total = async () => Object.entries(await counts(a.t, a.orgId)).reduce((sum, [name, n]) => name.endsWith("All") ? sum : sum + n, 0);
    const drops: number[] = [];
    let rows = await total();
    await a.client.mutation(api.workspace.confirmDelete, { orgId: a.orgId, confirmName: "A Org", sha256: (await exportOf(a.client, a.orgId)).sha256 });
    drops.push(rows - (rows = await total()));
    for (; rows > 0 && drops.length < 200;) { vi.runOnlyPendingTimers(); await a.t.finishInProgressScheduledFunctions(); const now = await total(); drops.push(rows - now); rows = now; }
    expect(drops[0]).toBe(0);
    expect(Math.max(...drops)).toBeLessThanOrEqual(200);
    await a.t.finishAllScheduledFunctions(vi.runAllTimers);
    const afterA = await counts(a.t, a.orgId);
    for (const name of [...orgTables, "orgs"]) expect(afterA[name], name).toBe(0);
    expect(afterA.integrationPagesAll).toBe(beforeA.integrationPagesAll - 1);
    expect(afterA.usersAll).toBe(beforeA.usersAll);
    expect(await counts(a.t, orgB)).toEqual({ ...beforeB, integrationPagesAll: beforeB.integrationPagesAll - 1 });
    expect((await b.query(api.records.search, { orgId: orgB, text: "B secret" })).length).toBe(1);
  });

  it("deletes the children of every parent, even past the first hundred parents", async () => {
    const a = await filled("A");
    await seedEverywhere(a.t, a.orgId);
    await a.t.run(async (ctx: any) => {
      const orgId = a.orgId, connectionId = (await ctx.db.query("integrationConnections").collect()).find((c: any) => c.orgId === orgId)._id;
      for (let i = 0; i < 150; i++) {
        const late = i >= 140;
        const cursorId = await ctx.db.insert("integrationCursors", { orgId, connectionId, resource: `r${i}`, checkpoint: 0, traversal: "t", nextPage: 0, complete: false });
        const bindingId = await ctx.db.insert("integrationBindings", { orgId, connectionId, provider: "p", environment: "test", account: "a", kind: "k", externalId: `e${i}`, connected: true });
        const targetId = await ctx.db.insert("safetyTargets", { orgId, bindingId, documentRef: `d${i}`, providerRef: "pr", kind: "payment", currency: "usd", paidMinor: 0, refundedMinor: 0, pendingRefundMinor: 0, cancelled: false, generation: 0, startedAt: 1, complete: false, providerPendingMinor: 0 });
        if (!late) continue;
        await ctx.db.insert("integrationPages", { cursorId, traversal: "t", page: 0, digest: "d" });
        await ctx.db.insert("integrationLookups", { orgId, connectionId, cursorId, resource: "r", traversal: "t", pageCount: 0, digest: "d", completedAt: 1 });
        await ctx.db.insert("integrationCallbacks", { orgId, bindingId, eventId: `ev${i}`, digest: "d", receivedAt: 1 });
        await ctx.db.insert("integrationObservations", { orgId, bindingId, version: 1, state: "s", observedAt: 1 });
        await ctx.db.insert("integrationReceipts", { orgId, targetId, provider: "p", environment: "test", account: "a", kind: "refund", receipt: { receiptId: `r${i}`, sourceRef: "s", status: "pending", amountMinor: 1, currency: "usd" } });
      }
    });
    vi.useFakeTimers();
    await a.client.mutation(api.workspace.confirmDelete, { orgId: a.orgId, confirmName: "A Org", sha256: (await exportOf(a.client, a.orgId)).sha256 });
    await a.t.finishAllScheduledFunctions(vi.runAllTimers);
    const left = await counts(a.t, a.orgId);
    for (const name of [...orgTables, "orgs"]) expect(left[name], name).toBe(0);
    expect(left.integrationPagesAll).toBe(0);
  });

  it("resumes a deletion whose purge chain stopped", async () => {
    const a = await filled("A");
    vi.useFakeTimers();
    // A workspace marked for deletion with no purge scheduled, as after a purge step that threw.
    await a.t.run(async (ctx: any) => ctx.db.patch(a.orgId, { deletingAt: Date.now() }));
    await a.t.mutation(internal.workspace.resumeDeletions, {});
    await a.t.finishAllScheduledFunctions(vi.runAllTimers);
    const left = await counts(a.t, a.orgId);
    for (const name of [...orgTables, "orgs"]) expect(left[name], name).toBe(0);
  });
});
