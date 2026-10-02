import { describe, expect, it } from "vitest";
import { api, agentFor, bulk, objectFields, rest, userAndOrg } from "./test.helpers";

const fill = (item: any, values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).map(([k, v]) => [item.fields[k]._id, v]));

async function fixture() {
  const org = await userAndOrg();
  const [person, company, activity] = await Promise.all(["person", "company", "activity"].map(key => objectFields(org.client, org.orgId, key)));
  const create = async (item: any, values: Record<string, unknown>) => (await org.client.mutation(api.records.create, { orgId: org.orgId, objectId: item.object._id, values: fill(item, values) })).recordId;
  const acme = await create(company, { name: "Acme" });
  const ada = await create(person, { name: "Ada", email: "ada@example.com", phone: "555-0100", title: "CTO", company: acme, linkedin: "in/ada" });
  return { ...org, person, company, activity, create, acme, ada };
}

describe("Gmail sync key", () => {
  it("reads only person name and email, creates activities, and can do nothing else", async () => {
    const { t, client, orgId, create, activity, ada, acme } = await fixture();
    const { key, agentId } = await client.action(api.agents.createGmailSync, { orgId });
    const listed = (await client.query(api.agents.list, { orgId })).find((a: any) => a._id === agentId);
    expect(listed).toMatchObject({ name: "Gmail sync", grants: [], access: ["read person", "read activity", "create activity"] });
    const call = rest(t, key);
    const people = await call("GET", "/api/v1/records?object=person");
    expect(people.status).toBe(200);
    expect(people.json.records).toHaveLength(1);
    expect(people.json.records[0]).toMatchObject({ id: ada, title: "Ada" });
    expect(people.json.records[0].values).toEqual({ name: "Ada", email: "ada@example.com" });
    expect((await call("GET", `/api/v1/records/${ada}`)).json.record.values).toEqual({ name: "Ada", email: "ada@example.com" });
    expect((await call("GET", "/api/v1/objects")).json.map((o: any) => [o.key, o.fields.map((f: any) => f.key)])).toEqual([["person", ["name", "email"]], ["activity", ["title", "type", "when", "about", "source"]]]);
    for (const object of ["company", "opportunity", "task", "note", "project", "campaign"]) expect((await call("GET", `/api/v1/records?object=${object}`)).status).toBe(404);
    expect((await call("GET", `/api/v1/records/${acme}`)).status).toBe(404);
    expect((await call("GET", "/api/v1/search?q=Acme")).json).toEqual([]);

    const logged = await call("POST", "/api/v1/changes", { action: "create", object: "activity", values: { title: "Email received", type: "email", when: "2026-09-30T13:05:00Z", about: ada, source: "gmail:abc" }, reason: "Gmail sync" });
    expect(logged.status).toBe(200);
    expect(logged.json.record.values).toMatchObject({ type: "email", when: "2026-09-30T13:05:00.000Z", about: { id: ada }, source: "gmail:abc" });

    const other = await create(activity, { title: "Call", type: "call" });
    const refused = [
      await call("POST", "/api/v1/changes", { action: "update", record: ada, values: { email: "x@example.com" }, reason: "x" }),
      await call("POST", "/api/v1/changes", { action: "delete", record: ada, reason: "x" }),
      await call("POST", "/api/v1/changes", { action: "update", record: other, values: { title: "Changed" }, reason: "x" }),
      await call("POST", "/api/v1/changes", { action: "update", record: logged.json.record.id, values: { title: "Changed" }, reason: "x" }),
      await call("POST", "/api/v1/changes", { action: "delete", record: logged.json.record.id, reason: "x" }),
      await call("POST", "/api/v1/changes", { action: "create", object: "person", values: { name: "Eve" }, reason: "x" }),
      await call("POST", "/api/v1/changes", { action: "create", object: "company", values: { name: "Eve Inc" }, reason: "x" }),
      await call("POST", "/api/v1/suggestions", { action: "update", record: ada, values: { name: "Ada L" }, reason: "x" }),
      await call("POST", "/api/v1/suggestions", { action: "create", object: "activity", values: { title: "x" }, reason: "x" }),
    ];
    expect(refused.map(r => r.status)).toEqual([403, 403, 403, 403, 403, 403, 403, 403, 403]);
    expect((await call("POST", "/api/v1/changes", { action: "create", object: "activity", values: { title: "x", about: acme }, reason: "x" })).status).toBe(400);
    const stored = await client.query(api.records.get, { orgId, recordId: ada });
    expect(stored!.record.values).toMatchObject(fill(await objectFields(client, orgId, "person"), { name: "Ada", email: "ada@example.com" }));
  });

  it("only an owner can mint it", async () => {
    const { t, client, orgId } = await fixture();
    await client.mutation(api.invites.create, { orgId, role: "admin" }).then(async ({ token }: any) => {
      const admin = t.withIdentity({ tokenIdentifier: "clerk|B", name: "B" });
      await admin.mutation(api.users.store, {});
      await admin.mutation(api.invites.accept, { token });
      await expect(admin.action(api.agents.createGmailSync, { orgId })).rejects.toThrow(/Owner required|Membership required/);
      expect(await client.query(api.agents.list, { orgId })).toEqual([]);
    });
  });
});

describe("Idempotency-Key on changes", () => {
  it("a repeated key returns the first result and writes nothing new", async () => {
    const { t, client, orgId, ada, activity } = await fixture();
    const { key } = await agentFor(client, orgId, { name: "sync", grants: [{ action: "create", objectKey: "activity" }] });
    const post = (idempotencyKey: string, title: string) => t.fetch("/api/v1/changes", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": idempotencyKey }, body: JSON.stringify({ action: "create", object: "activity", values: { title, type: "email", when: "2026-09-30T13:05:00Z", about: ada, source: "gmail:m1" }, reason: "Gmail sync" }) }).then(async r => ({ status: r.status, json: await r.json() }));
    const first = await post("gmail:m1", "Email received"), again = await post("gmail:m1", "Email received");
    expect(first.status).toBe(200); expect(again.status).toBe(200);
    expect(again.json.record.id).toBe(first.json.record.id);
    expect(again.json.eventId).toBe(first.json.eventId);
    const other = await post("gmail:m2", "Email received");
    expect(other.json.record.id).not.toBe(first.json.record.id);
    const rows = await client.query(api.records.list, { orgId, objectId: activity.object._id, paginationOpts: { numItems: 50, cursor: null } });
    expect(rows.page).toHaveLength(2);
    // Keys belong to the workspace, so a replacement key replays the old key's posts instead of duplicating them.
    const second = await agentFor(client, orgId, { name: "replacement", grants: [{ action: "create", objectKey: "activity" }] });
    const theirs = await t.fetch("/api/v1/changes", { method: "POST", headers: { authorization: `Bearer ${second.key}`, "content-type": "application/json", "idempotency-key": "gmail:m1" }, body: JSON.stringify({ action: "create", object: "activity", values: { title: "x" }, reason: "x" }) }).then(r => r.json());
    expect(theirs).toMatchObject({ record: { id: first.json.record.id }, eventId: null });
    expect((await client.query(api.records.list, { orgId, objectId: activity.object._id, paginationOpts: { numItems: 50, cursor: null } })).page).toHaveLength(2);
    // A key without the grant gets the same refusal whether or not the key was used, so keys cannot be probed.
    const noGrant = await agentFor(client, orgId, { name: "prober" });
    const probe = (k: string) => t.fetch("/api/v1/changes", { method: "POST", headers: { authorization: `Bearer ${noGrant.key}`, "content-type": "application/json", "idempotency-key": k }, body: JSON.stringify({ action: "create", object: "activity", values: { title: "x" }, reason: "x" }) }).then(r => r.status);
    expect([await probe("gmail:m1"), await probe("never-used")]).toEqual([403, 403]);
    // Another workspace's identical key is unrelated.
    const awayIdentity = t.withIdentity({ tokenIdentifier: "clerk|Away", name: "Away" });
    await awayIdentity.mutation(api.users.store, {});
    const awayOrg = await awayIdentity.mutation(api.orgs.create, { name: "Away Org" }), awayKey = await agentFor(awayIdentity, awayOrg, { name: "sync", grants: [{ action: "create", objectKey: "activity" }] });
    const elsewhere = await t.fetch("/api/v1/changes", { method: "POST", headers: { authorization: `Bearer ${awayKey.key}`, "content-type": "application/json", "idempotency-key": "gmail:m1" }, body: JSON.stringify({ action: "create", object: "activity", values: { title: "x" }, reason: "x" }) }).then(r => r.json());
    expect(elsewhere.record.id).not.toBe(first.json.record.id);
    expect((await t.fetch("/api/v1/changes", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": "x".repeat(300) }, body: JSON.stringify({ action: "create", object: "activity", values: { title: "x" }, reason: "x" }) })).status).toBe(400);
  });
});

describe("last contact", () => {
  it("is the newest past activity about each person, and skips activities the reader cannot see", async () => {
    const { t, client, orgId, create, activity, person, ada } = await fixture();
    const bob = await create(person, { name: "Bob", email: "bob@example.com" });
    const older = await create(activity, { title: "Old email", type: "email", when: Date.UTC(2026, 7, 1, 9, 0), about: ada });
    const newest = await create(activity, { title: "Reply", type: "email", when: Date.UTC(2026, 8, 29, 16, 45), about: ada });
    await create(activity, { title: "Mid call", type: "call", when: Date.UTC(2026, 8, 2), about: ada });
    await create(activity, { title: "Planned meeting", type: "meeting", when: Date.now() + 7 * 86400000, about: ada });
    await create(activity, { title: "Undated", type: "other", about: ada });
    await create(activity, { title: "Bob call", type: "call", when: Date.UTC(2026, 6, 4), about: bob });
    expect(await client.query(api.records.lastContact, { orgId, recordIds: [ada, bob] })).toEqual({ [ada]: Date.UTC(2026, 8, 29, 16, 45), [bob]: Date.UTC(2026, 6, 4) });

    // A member who may read every activity except the newest sees the next one down.
    const member = t.withIdentity({ tokenIdentifier: "clerk|M", name: "M" });
    await member.mutation(api.users.store, {});
    const { token } = await client.mutation(api.invites.create, { orgId, role: "member" });
    await member.mutation(api.invites.accept, { token });
    const all = (await client.query(api.records.list, { orgId, objectId: activity.object._id, paginationOpts: { numItems: 50, cursor: null } })).page.map((r: any) => r._id);
    const setScopes = (readScopes: any) => t.run(async (ctx: any) => { const row = (await ctx.db.query("members").collect()).find((m: any) => m.role === "member"); await ctx.db.patch(row._id, { readScopes }); });
    const everyObject = async (activityScope: any) => [...(await client.query(api.objects.list, { orgId })).filter((o: any) => o.key !== "activity").map((o: any) => ({ objectId: o._id, records: "all", fields: "all" })), ...(activityScope ? [activityScope] : [])];
    await setScopes(await everyObject({ objectId: activity.object._id, records: all.filter((id: any) => id !== newest), fields: "all" }));
    expect(await member.query(api.records.lastContact, { orgId, recordIds: [ada] })).toEqual({ [ada]: Date.UTC(2026, 8, 2) });
    // Without the When field, or without Activity at all, there is nothing to show.
    await setScopes(await everyObject({ objectId: activity.object._id, records: "all", fields: [activity.fields.title._id, activity.fields.about._id] }));
    expect(await member.query(api.records.lastContact, { orgId, recordIds: [ada] })).toEqual({});
    await setScopes(await everyObject(null));
    expect(await member.query(api.records.lastContact, { orgId, recordIds: [ada, bob] })).toEqual({});
    // When visible on only some activities: the answer must not depend on how many newer ones hide it.
    await setScopes(await everyObject(null).then(rows => [...rows, { objectId: activity.object._id, records: "all", fields: [activity.fields.title._id, activity.fields.about._id] }, { objectId: activity.object._id, records: [older], fields: "all" }]));
    expect(await member.query(api.records.lastContact, { orgId, recordIds: [ada] })).toEqual({ [ada]: Date.UTC(2026, 7, 1, 9, 0) });
    await bulk(t, orgId, async (apply) => { for (let i = 0; i < 1001; i++) await apply({ action: "create", objectId: activity.object._id, values: fill(activity, { title: `Hidden ${i}`, when: Date.UTC(2026, 8, 10), about: ada }) }); });
    expect(await member.query(api.records.lastContact, { orgId, recordIds: [ada] })).toEqual({ [ada]: Date.UTC(2026, 7, 1, 9, 0) });
    // A person the reader cannot see gets no answer either.
    await setScopes([{ objectId: person.object._id, records: [bob], fields: "all" }, { objectId: activity.object._id, records: "all", fields: "all" }]);
    expect(await member.query(api.records.lastContact, { orgId, recordIds: [ada, bob] })).toEqual({ [bob]: Date.UTC(2026, 6, 4) });
  });
});
