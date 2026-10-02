import { afterEach, describe, expect, it, vi } from "vitest";
import { anyApi } from "convex/server";
import schema from "./schema";
import { agentFor, api, bulk, objectFields, rest, userAndOrg } from "./test.helpers";
import { internal } from "./_generated/api";
import { BATCH, NO_EXPORT, pacer, planImport, withRetry } from "./workspace";
import { principalFor } from "./authority/grants";

// Replaces every id with the order it first appears in, so two exports compare by shape and links, not by id.
function modIds(data: any) {
  const seen = new Map<string, string>();
  const ids = new Set<string>([...data.objects, ...data.fields, ...data.records, ...data.events].map((row: any) => row.id));
  for (const event of data.events) ids.add(event.record);
  const walk = (value: any): any => typeof value === "string" ? (ids.has(value) ? (seen.get(value) ?? (seen.set(value, `#${seen.size}`), `#${seen.size - 1}`)) : value) : Array.isArray(value) ? value.map(walk) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)])) : value;
  const rest = data;
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
// Export runs as an action that leaves the file in storage; the tests read it back from there.
const exportOf = async (t: any, client: any, orgId: any): Promise<any> => { const { storageId } = await client.action(api.workspace.exportAll, { orgId }); return JSON.parse(await t.run(async (ctx: any) => (await ctx.storage.get(storageId)).text())); };
const upload = (t: any, data: unknown): Promise<any> => t.run((ctx: any) => ctx.storage.store(new Blob([typeof data === "string" ? data : JSON.stringify(data)])));
// What the browser does: upload, register the upload as its own, then import it.
const importFile = async (t: any, client: any, data: unknown): Promise<any> => { const storageId = await upload(t, data); await client.mutation(api.workspace.importUploaded, { storageId }); return client.action(api.workspace.importAll, { storageId }); };
const fileExists = (t: any, storageId: any) => t.run(async (ctx: any) => (await ctx.storage.get(storageId)) !== null);

// convex-test simulates thousands of rows in memory; the 3,000-person case needs more than the default 15 s.
const HEAVY = 60_000;
const ownerOnly = { data: { code: "FORBIDDEN" } };
const refused = (why: RegExp) => ({ data: { code: "VALIDATION", message: expect.stringMatching(why) } });
afterEach(() => { vi.useRealTimers(); });

describe("full workspace export", () => {
  it("writes definitions, records keyed by field key, links by record id and the whole history", async () => {
    const a = await filled("A");
    const data = await exportOf(a.t, a.client, a.orgId);
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
  });

  it("contains nothing from another workspace and is refused to anyone but an unrestricted owner", async () => {
    const a = await filled("A");
    const b = await second(a.t);
    const orgB = await b.mutation(api.orgs.create, { name: "B Org" });
    const company = await objectFields(b, orgB, "company");
    const secret = (await b.mutation(api.records.create, { orgId: orgB, objectId: company.object._id, values: { [company.fields.name._id]: "B secret" } })).recordId;
    const text = JSON.stringify(await exportOf(a.t, a.client, a.orgId));
    for (const leak of ["B secret", secret, orgB, company.object._id]) expect(text).not.toContain(leak);
    await expect(exportOf(a.t, b, a.orgId)).rejects.toMatchObject(ownerOnly);
    await joinAs(a, b, "admin");
    await expect(exportOf(a.t, b, a.orgId)).rejects.toMatchObject(ownerOnly);
  });

  it("Export is refused to an owner with hidden fields or record scopes", async () => {
    const a = await filled("A");
    const before = await exportOf(a.t, a.client, a.orgId);
    const memberId = await a.t.run(async (ctx: any) => (await ctx.db.query("members").collect())[0]._id);
    await a.client.mutation(anyApi["authority/policies"].setMember, { orgId: a.orgId, memberId, hiddenFieldIds: [a.company.fields.city._id] });
    await expect(exportOf(a.t, a.client, a.orgId)).rejects.toMatchObject(ownerOnly);
    void before;
    await expect(a.client.mutation(api.workspace.confirmDelete, { orgId: a.orgId, confirmName: "A Org", withoutExport: NO_EXPORT })).rejects.toMatchObject(ownerOnly);
  });

  it("pages through a workspace larger than one page and holds writes while it reads", async () => {
    const a = await filled("A");
    const note = await objectFields(a.client, a.orgId, "note");
    await a.t.run(async (ctx: any) => { const user = (await ctx.db.query("users").first())._id; for (let i = 0; i < 1200; i++) await ctx.db.insert("records", { orgId: a.orgId, objectId: note.object._id, values: { [note.fields.body._id]: `n${i}` }, title: `n${i}`, createdBy: user, updatedAt: 0 }); });
    expect((await exportOf(a.t, a.client, a.orgId)).records).toHaveLength(1205);
    vi.useFakeTimers();
    const token = await a.client.mutation(internal.workspace.exportBegin, { orgId: a.orgId });
    const write = () => a.client.mutation(api.records.update, { orgId: a.orgId, recordId: a.ann, values: { [a.person.fields.phone._id]: "9" } });
    await expect(write()).rejects.toMatchObject({ data: { code: "CONFLICT", message: expect.stringMatching(/being exported/) } });
    await expect(a.client.mutation(internal.workspace.exportBegin, { orgId: a.orgId })).rejects.toMatchObject({ data: { code: "CONFLICT" } });
    expect((await a.client.query(api.records.get, { orgId: a.orgId, recordId: a.ann }))!.record._id).toBe(a.ann);
    // A stuck export releases the workspace on its own, and can no longer finish.
    vi.advanceTimersByTime(5 * 60_000 + 1);
    await write();
    await expect(a.client.mutation(internal.workspace.exportEnd, { orgId: a.orgId, token, done: true })).rejects.toMatchObject({ data: { code: "CONFLICT" } });
  });

  it("measures the export and import limits in UTF-8 bytes, not characters", async () => {
    const a = await userAndOrg("A");
    const note = await objectFields(a.client, a.orgId, "note");
    await a.client.mutation(api.records.create, { orgId: a.orgId, objectId: note.object._id, values: { [note.fields.body._id]: "é".repeat(20_000) } });
    const data = await exportOf(a.t, a.client, a.orgId);
    const chars = JSON.stringify(data).length, bytes = new TextEncoder().encode(JSON.stringify(data)).length;
    expect(bytes - chars).toBeGreaterThan(10_000);
    // A limit between the character count and the byte count: only a byte measure refuses.
    vi.stubEnv("REMOLD_EXPORT_MAX_BYTES", String(chars + 5_000));
    await expect(exportOf(a.t, a.client, a.orgId)).rejects.toMatchObject(refused(/larger than/));
    vi.stubEnv("REMOLD_EXPORT_MAX_BYTES", String(bytes + 5_000));
    await exportOf(a.t, a.client, a.orgId);
    vi.stubEnv("REMOLD_IMPORT_MAX_BYTES", String(chars + 5_000));
    await expect(importFile(a.t, a.client, data)).rejects.toMatchObject(refused(/larger than/));
    vi.stubEnv("REMOLD_IMPORT_MAX_BYTES", String(bytes + 5_000));
    await importFile(a.t, a.client, data);
    vi.unstubAllEnvs();
  });

  it("counts link values when it sizes each import write, and refuses one record with too many", async () => {
    const a = await filled("A");
    const data = await exportOf(a.t, a.client, a.orgId);
    const task = data.records.find((r: any) => r.values.title === "A first"), t2 = data.records.find((r: any) => r.values.title === "A second");
    const fieldOf = new Map<string, any>(data.fields.map((f: any) => [`${f.object}:${f.key}`, f]));
    // Two records with 200 links each weigh 201 writes apiece, so they cannot share one batch of at most 300.
    const heavy = (id: string) => ({ ...task, id, values: { title: id, blockedBy: Array(200).fill(t2.id) } });
    const batches = planImport({ ...data, records: [t2, heavy("h1"), heavy("h2")] }, fieldOf).batches;
    expect(batches.map((b: any[]) => b.map(r => r.id))).toEqual([[t2.id], ["h1"], ["h2"]]);
    // The import row cap counts link values too: 5 records, 8 events and 1 link fit under 20; 10 more links do not.
    vi.stubEnv("REMOLD_IMPORT_MAX_ROWS", "20");
    expect(data.records.length + data.events.length + 1).toBeLessThanOrEqual(20);
    await importFile(a.t, a.client, data);
    task.values.blockedBy = [...task.values.blockedBy, ...Array(10).fill(t2.id)];
    await expect(importFile(a.t, a.client, data)).rejects.toMatchObject(refused(/holds 24 records, history entries and links; one import takes up to 20/));
    vi.unstubAllEnvs();
    task.values.blockedBy = Array(300).fill(t2.id);
    await expect(importFile(a.t, a.client, data)).rejects.toMatchObject(refused(/more than 299 relation values/));
  });

  it("exports and restores a realistic workspace of 3,000 people with their history", async () => {
    const a = await userAndOrg("A");
    const person = await objectFields(a.client, a.orgId, "person"), company = await objectFields(a.client, a.orgId, "company");
    await bulk(a.t, a.orgId, async (apply) => {
      const companies = [];
      for (let i = 0; i < 50; i++) companies.push((await apply({ action: "create", objectId: company.object._id, values: { [company.fields.name._id]: `Company ${i}` } })).recordId);
      for (let i = 0; i < 3000; i++) await apply({ action: "create", objectId: person.object._id, values: { [person.fields.name._id]: `Person ${i}`, [person.fields.email._id]: `p${i}@example.invalid`, [person.fields.company._id]: companies[i % 50] } });
    });
    const data = await exportOf(a.t, a.client, a.orgId);
    expect(data.records).toHaveLength(3050);
    expect(data.events).toHaveLength(3050);
    const fresh = await importFile(a.t, a.client, data);
    expect(modIds(await exportOf(a.t, a.client, fresh))).toEqual(modIds(data));
  }, HEAVY);
});

describe("workspace import", () => {
  it("restores an export into a new workspace with new ids, links intact, and re-exports the same", async () => {
    const a = await filled("A");
    const original = await exportOf(a.t, a.client, a.orgId);
    const fresh = await importFile(a.t, a.client, original);
    const again = await exportOf(a.t, a.client, fresh);
    expect(again.workspace.name).toBe("A Org");
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
    // The upload is removed once it has been read.
    expect(await a.t.run(async (ctx: any) => (await ctx.db.system.query("_storage").collect()).length)).toBe(2);
  });

  it("writes each record once, in dependency order, and closes relation cycles afterwards", async () => {
    const a = await filled("A");
    const task = await objectFields(a.client, a.orgId, "task");
    // Two tasks blocking each other, and one blocking itself.
    const [x, y] = await Promise.all(["x", "y"].map(async title => (await a.client.mutation(api.records.create, { orgId: a.orgId, objectId: task.object._id, values: { [task.fields.title._id]: title } })).recordId));
    await a.client.mutation(api.records.update, { orgId: a.orgId, recordId: x, values: { [task.fields.blockedBy._id]: [y, x] } });
    await a.client.mutation(api.records.update, { orgId: a.orgId, recordId: y, values: { [task.fields.blockedBy._id]: [x] } });
    const data = await exportOf(a.t, a.client, a.orgId);
    const fresh = await importFile(a.t, a.client, data);
    expect(modIds(await exportOf(a.t, a.client, fresh))).toEqual(modIds(data));
    const rows = (orgId: any) => a.t.run(async (ctx: any) => (await ctx.db.query("links").collect()).filter((l: any) => l.orgId === orgId).length);
    expect(await rows(fresh)).toBe(await rows(a.orgId));
  });

  it("rejects unknown fields, duplicate ids or keys and bad relations with the reason, and creates nothing", async () => {
    const a = await filled("A");
    const good = await exportOf(a.t, a.client, a.orgId);
    const rows = () => a.t.run(async (ctx: any) => { const out: Record<string, number> = {}; for (const table of Object.keys(schema.tables)) out[table] = (await ctx.db.query(table).collect()).length; return out; });
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
      ["bad boolean", d => { d.records.find((r: any) => r.values.title === "A first").values.done = "yes"; }, /invalid value in "done"/],
      ["event that does not match its action", d => { d.events[0].before = {}; }, /does not match its action/],
      ["wrong version", d => { d.version = 99; }, /version 1/],
      ["no workspace name", d => { d.workspace = {}; }, /no name/],
    ];
    for (const [name, corrupt, why] of cases) {
      const data = copy(); corrupt(data);
      await expect(importFile(a.t, a.client, data), name).rejects.toMatchObject(refused(why));
    }
    await expect(importFile(a.t, a.client, "{not json")).rejects.toMatchObject(refused(/not JSON/));
    expect(await rows()).toEqual(before);
  });

  it("follows the workspace-creation gate", async () => {
    const a = await filled("A");
    const data = await exportOf(a.t, a.client, a.orgId);
    vi.stubEnv("REMOLD_OPEN_SIGNUP", "0");
    await expect(importFile(a.t, a.client, data)).rejects.toMatchObject(ownerOnly);
    await expect(a.client.mutation(api.workspace.importUploadUrl, {})).rejects.toMatchObject(ownerOnly);
    vi.unstubAllEnvs();
  });

  it("stages into a hidden workspace only its import can write, and purges it when the import fails", async () => {
    const a = await filled("A");
    const data = await exportOf(a.t, a.client, a.orgId);
    const { orgId, token, objects } = await a.client.mutation(internal.workspace.importStart, { name: "Staging", objects: data.objects, fields: data.fields });
    expect((await a.client.query(api.orgs.mine, {})).map((m: any) => m.org.name)).not.toContain("Staging");
    await expect(a.client.query(api.orgs.get, { orgId })).rejects.toMatchObject(ownerOnly);
    const object = Object.values(objects)[0] as any;
    await expect(a.client.mutation(api.records.create, { orgId, objectId: object, values: {} })).rejects.toMatchObject(ownerOnly);
    // One import per staging workspace: a step without its token, or from someone else, is refused.
    const row = { objectId: object, updatedAt: 0, title: "", values: {} };
    await expect(a.client.mutation(internal.workspace.importRecords, { orgId, token: token + 1, rows: [row] })).rejects.toMatchObject({ data: { code: "CONFLICT" } });
    const b = await second(a.t);
    await expect(b.mutation(internal.workspace.importRecords, { orgId, token, rows: [row] })).rejects.toMatchObject({ data: { code: "CONFLICT" } });
    await a.client.mutation(internal.workspace.importRecords, { orgId, token, rows: [row] });
    vi.useFakeTimers();
    await a.client.mutation(internal.workspace.importAbort, { orgId, token });
    await a.t.finishAllScheduledFunctions(vi.runAllTimers);
    const left = await counts(a.t, orgId);
    for (const name of [...orgTables, "orgs"]) expect(left[name], name).toBe(0);
  });

  it("reads only an upload the signed-in caller registered, behind the creation gate, and never deletes anyone else's file", async () => {
    const a = await filled("A");
    const exportFile = (await a.client.action(api.workspace.exportAll, { orgId: a.orgId })).storageId;
    const data = await exportOf(a.t, a.client, a.orgId);
    const mine = await upload(a.t, data);
    await a.client.mutation(api.workspace.importUploaded, { storageId: mine });
    // Signed out.
    await expect(a.t.action(api.workspace.importAll, { storageId: mine })).rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
    // Another signed-in user, with A's upload or A's export file.
    const b = await second(a.t);
    await expect(b.action(api.workspace.importAll, { storageId: mine })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
    await expect(b.action(api.workspace.importAll, { storageId: exportFile })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
    await expect(b.mutation(api.workspace.importUploaded, { storageId: exportFile })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
    await expect(b.mutation(api.workspace.importUploaded, { storageId: mine })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
    // An export file cannot be imported by id, even by its owner, and an unregistered upload is refused.
    await expect(a.client.action(api.workspace.importAll, { storageId: exportFile })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
    const unregistered = await upload(a.t, data);
    await expect(a.client.action(api.workspace.importAll, { storageId: unregistered })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
    // The creation gate is checked before the file is touched.
    vi.stubEnv("REMOLD_OPEN_SIGNUP", "0");
    await expect(a.client.action(api.workspace.importAll, { storageId: mine })).rejects.toMatchObject(ownerOnly);
    vi.unstubAllEnvs();
    for (const id of [exportFile, mine, unregistered]) expect(await fileExists(a.t, id)).toBe(true);
    // The owner's own registered upload imports, and is removed afterwards.
    await a.client.action(api.workspace.importAll, { storageId: mine });
    expect(await fileExists(a.t, mine)).toBe(false);
  });

  it("purges a staging workspace its import left behind once it is older than the action time limit", async () => {
    const a = await filled("A");
    const data = await exportOf(a.t, a.client, a.orgId);
    vi.useFakeTimers();
    const left = await a.client.mutation(internal.workspace.importStart, { name: "Left behind", objects: data.objects, fields: data.fields });
    await a.client.mutation(internal.workspace.importRecords, { orgId: left.orgId, token: left.token, rows: [{ objectId: Object.values(left.objects)[0], updatedAt: 0, title: "", values: {} }] });
    // Within the action time limit the import may still be running: the cron leaves it alone.
    vi.advanceTimersByTime(9 * 60_000);
    await a.t.mutation(internal.workspace.resumeDeletions, {});
    await a.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await counts(a.t, left.orgId)).orgs).toBe(1);
    expect(((await a.t.run((ctx: any) => ctx.db.get(left.orgId))) as any).deletingAt).toBeUndefined();
    vi.advanceTimersByTime(7 * 60_000);
    await a.t.mutation(internal.workspace.resumeDeletions, {});
    await a.t.finishAllScheduledFunctions(vi.runAllTimers);
    const after = await counts(a.t, left.orgId);
    for (const name of [...orgTables, "orgs"]) expect(after[name], name).toBe(0);
  });

  it("lets an operator abort a stuck import by workspace id, and nothing else", async () => {
    const a = await filled("A");
    const data = await exportOf(a.t, a.client, a.orgId);
    const stuck = await a.client.mutation(internal.workspace.importStart, { name: "Stuck", objects: data.objects, fields: data.fields });
    await expect(a.t.mutation(internal.workspace.abortImport, { orgId: a.orgId })).rejects.toMatchObject({ data: { code: "VALIDATION" } });
    vi.useFakeTimers();
    await a.t.mutation(internal.workspace.abortImport, { orgId: stuck.orgId });
    await a.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await counts(a.t, stuck.orgId)).orgs).toBe(0);
    expect((await a.client.query(api.orgs.get, { orgId: a.orgId })).name).toBe("A Org");
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
    const data = await exportOf(a.t, a.client, a.orgId);
    expect(JSON.stringify(data)).not.toContain("CONFIDENTIAL");
    const fresh = await importFile(a.t, a.client, data);
    const stored = await a.t.run(async (ctx: any) => (await ctx.db.query("events").collect()).filter((e: any) => e.orgId === fresh).map((e: any) => e.actor));
    expect(stored.every((actor: any) => actor.kind === "imported" && typeof actor.name === "string" && !("id" in actor))).toBe(true);
  });

  it("keeps imported history in its original order next to later native activity", async () => {
    // Only the clock is fake: the import's pacing still sleeps on real timers.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 0, 1, 10));
    const a = await userAndOrg("A");
    const person = await objectFields(a.client, a.orgId, "person");
    const ann = (await a.client.mutation(api.records.create, { orgId: a.orgId, objectId: person.object._id, values: { [person.fields.name._id]: "Ann" } })).recordId;
    vi.setSystemTime(Date.UTC(2026, 0, 2, 10));
    await a.client.mutation(api.records.update, { orgId: a.orgId, recordId: ann, values: { [person.fields.email._id]: "ann@example.invalid" } });
    const data = await exportOf(a.t, a.client, a.orgId);
    vi.setSystemTime(Date.UTC(2026, 5, 1, 10));
    const fresh = await importFile(a.t, a.client, data);
    const copy = (await exportOf(a.t, a.client, fresh)).records[0].id;
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
    await ctx.db.insert("workspaceFiles", { orgId, userId: member.userId, kind: "export", storageId: await ctx.storage.store(new Blob(["{}"])) });
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
  it("needs the owner, the exact name and a fresh export or the typed phrase, then closes the workspace at once", async () => {
    const a = await filled("A");
    const agent = await agentFor(a.client, a.orgId, { name: "bot" });
    const b = await second(a.t);
    await joinAs(a, b, "admin");
    const confirm = (client: any, args: any = {}) => client.mutation(api.workspace.confirmDelete, { orgId: a.orgId, confirmName: "A Org", ...args });
    vi.useFakeTimers();
    await expect(confirm(a.client)).rejects.toMatchObject(refused(/Export the workspace first, or type DELETE WITHOUT EXPORT/));
    for (const withoutExport of ["delete without export", "DELETE"]) await expect(confirm(a.client, { withoutExport })).rejects.toMatchObject(refused(/exactly to delete without an export/));
    await expect(confirm(a.client, { confirmName: "A org", withoutExport: NO_EXPORT })).rejects.toMatchObject(refused(/name exactly/));
    await expect(confirm(b, { withoutExport: NO_EXPORT })).rejects.toMatchObject(ownerOnly);
    // An export finished more than a day ago no longer counts.
    await exportOf(a.t, a.client, a.orgId);
    vi.advanceTimersByTime(24 * 60 * 60_000 + 1);
    await expect(confirm(a.client)).rejects.toMatchObject(refused(/Export the workspace first/));
    await exportOf(a.t, a.client, a.orgId);
    expect((await a.client.query(api.orgs.get, { orgId: a.orgId })).name).toBe("A Org");
    const invite = await a.client.mutation(api.invites.create, { orgId: a.orgId, role: "member" });
    const reminderFor = await a.t.run(async (ctx: any) => { const m = (await ctx.db.query("members").collect()).find((x: any) => x.orgId === a.orgId && x.role === "owner"); await ctx.db.patch(m._id, { dailyReminder: true }); await ctx.db.patch(m.userId, { email: "a@example.invalid" }); return m._id; });
    const before = await counts(a.t, a.orgId);
    await confirm(a.client);
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
    const fileOf = (orgId: any) => a.t.run(async (ctx: any) => (await ctx.db.query("workspaceFiles").collect()).find((f: any) => f.orgId === orgId).storageId);
    const fileA = await fileOf(a.orgId), fileB = await fileOf(orgB);
    for (const name of orgTables) expect(beforeA[name], `fixture must seed ${name}`).toBeGreaterThan(0);
    vi.useFakeTimers();
    const total = async () => Object.entries(await counts(a.t, a.orgId)).reduce((sum, [name, n]) => name.endsWith("All") ? sum : sum + n, 0);
    const drops: number[] = [];
    let rows = await total();
    await a.client.mutation(api.workspace.confirmDelete, { orgId: a.orgId, confirmName: "A Org", withoutExport: NO_EXPORT });
    drops.push(rows - (rows = await total()));
    for (; rows > 0 && drops.length < 200;) { vi.runOnlyPendingTimers(); await a.t.finishInProgressScheduledFunctions(); const now = await total(); drops.push(rows - now); rows = now; }
    expect(drops[0]).toBe(0);
    expect(Math.max(...drops)).toBeLessThanOrEqual(BATCH);
    await a.t.finishAllScheduledFunctions(vi.runAllTimers);
    const afterA = await counts(a.t, a.orgId);
    for (const name of [...orgTables, "orgs"]) expect(afterA[name], name).toBe(0);
    expect(afterA.integrationPagesAll).toBe(beforeA.integrationPagesAll - 1);
    expect(afterA.usersAll).toBe(beforeA.usersAll);
    expect(await counts(a.t, orgB)).toEqual({ ...beforeB, integrationPagesAll: beforeB.integrationPagesAll - 1 });
    expect((await b.query(api.records.search, { orgId: orgB, text: "B secret" })).length).toBe(1);
    // An export file in storage goes with its workspace.
    expect(await fileExists(a.t, fileA)).toBe(false);
    expect(await fileExists(a.t, fileB)).toBe(true);
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
    await a.client.mutation(api.workspace.confirmDelete, { orgId: a.orgId, confirmName: "A Org", withoutExport: NO_EXPORT });
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

  it("purge does nothing to a workspace that is not being deleted", async () => {
    const a = await filled("A");
    await seedEverywhere(a.t, a.orgId);
    const before = await counts(a.t, a.orgId);
    await a.t.mutation(internal.workspace.purge, { orgId: a.orgId, step: 0 });
    expect(await counts(a.t, a.orgId)).toEqual(before);
  });
});

describe("import write pacing", () => {
  it("keeps staged writes under the byte budget across steps", async () => {
    let now = 0; const slept: number[] = [];
    const pace = pacer(1.5 * 1024 * 1024, () => now, async (ms) => { slept.push(ms); now += ms; });
    for (let i = 0; i < 10; i++) { await pace(1024 * 1024); now += 50; }
    // 10 MiB at 1.5 MiB/s takes at least about 6.7 s however fast each step returns.
    expect(now).toBeGreaterThanOrEqual(6_000);
    expect(now).toBeLessThan(8_000);
    expect(slept.length).toBeGreaterThan(0);
  });

  it("retries a write-rate refusal with growing waits, and passes any other error straight through", async () => {
    const slept: number[] = []; let calls = 0;
    const sleep = async (ms: number) => { slept.push(ms); };
    const flaky = async () => { calls += 1; if (calls < 3) throw new Error("Too many writes per second. Your deployment is limited to 4 MiB bytes written per 1 second."); return "done"; };
    expect(await withRetry(flaky, sleep)).toBe("done");
    expect(slept).toEqual([1000, 2000]);
    const refused = Object.assign(new Error("Import refused"), { data: { code: "VALIDATION" } });
    slept.length = 0;
    await expect(withRetry(async () => { throw refused; }, sleep)).rejects.toBe(refused);
    expect(slept).toEqual([]);
    await expect(withRetry(async () => { throw new Error("Too many writes per second"); }, sleep)).rejects.toThrow(/Too many writes/);
    expect(slept.length).toBe(6);
  });
});
