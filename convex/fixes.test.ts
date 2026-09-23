import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import { api, objectFields, userAndOrg } from "./test.helpers";

describe("deleting a record", () => {
  it("clears lookups that point at it, and says why in the timeline", async () => {
    const { client, orgId } = await userAndOrg();
    const company = await objectFields(client, orgId, "company"); const person = await objectFields(client, orgId, "person");
    const acme = await client.mutation(api.records.create, { orgId, objectId: company.object._id, values: { [company.fields.name._id]: "Acme" } });
    const ada = await client.mutation(api.records.create, { orgId, objectId: person.object._id, values: { [person.fields.name._id]: "Ada", [person.fields.company._id]: acme.recordId } });
    await client.mutation(api.records.remove, { orgId, recordId: acme.recordId });
    const got = await client.query(api.records.get, { orgId, recordId: ada.recordId });
    expect(got!.record.values[person.fields.company._id]).toBeUndefined();
    const [latest] = await client.query(api.events.forRecord, { orgId, recordId: ada.recordId });
    expect(latest).toMatchObject({ action: "update", reason: "Linked Acme was deleted", after: { [person.fields.company._id]: null } });
  });

  it("clears untargeted 'about' lookups on notes too", async () => {
    const { client, orgId } = await userAndOrg();
    const company = await objectFields(client, orgId, "company"); const note = await objectFields(client, orgId, "note");
    const acme = await client.mutation(api.records.create, { orgId, objectId: company.object._id, values: { [company.fields.name._id]: "Acme" } });
    const memo = await client.mutation(api.records.create, { orgId, objectId: note.object._id, values: { [note.fields.body._id]: "Call back", [note.fields.about._id]: acme.recordId } });
    await client.mutation(api.records.remove, { orgId, recordId: acme.recordId });
    expect((await client.query(api.records.get, { orgId, recordId: memo.recordId }))!.record.values[note.fields.about._id]).toBeUndefined();
  });
});

describe("required fields", () => {
  it("adding one later does not lock edits to older records", async () => {
    const { client, orgId } = await userAndOrg();
    const person = await objectFields(client, orgId, "person");
    const ada = await client.mutation(api.records.create, { orgId, objectId: person.object._id, values: { [person.fields.name._id]: "Ada" } });
    const { fieldId: source } = await client.mutation(api.fields.create, { orgId, objectId: person.object._id, key: "source", label: "Source", type: "text", required: true });
    await client.mutation(api.records.update, { orgId, recordId: ada.recordId, values: { [person.fields.phone._id]: "555" } });
    expect((await client.query(api.records.get, { orgId, recordId: ada.recordId }))!.record.values[person.fields.phone._id]).toBe("555");
    await expect(client.mutation(api.records.update, { orgId, recordId: ada.recordId, values: { [person.fields.name._id]: null } })).rejects.toMatchObject({ data: { code: "VALIDATION" } });
    await expect(client.mutation(api.records.create, { orgId, objectId: person.object._id, values: { [person.fields.name._id]: "Ben" } })).rejects.toMatchObject({ data: { code: "VALIDATION", fieldId: source } });
  });
});

describe("Company slots", () => {
  it("leave room for new sortable fields in a new org", async () => {
    const { client, orgId } = await userAndOrg();
    const company = await objectFields(client, orgId, "company");
    const made = await client.mutation(api.fields.create, { orgId, objectId: company.object._id, key: "industry", label: "Industry", type: "select", options: [{ id: "trades", label: "Trades" }] });
    expect(made.slot).toBeDefined();
  });

  it("are freed in an older org without leaving stale values behind", async () => {
    const { t, client, orgId } = await userAndOrg();
    const company = await objectFields(client, orgId, "company");
    // Recreate the old seeding: notes held a text slot and a record used it.
    await t.run(async (ctx) => { await ctx.db.patch(company.fields.notes._id, { slot: { kind: "s", index: 7 } }); });
    const acme = await client.mutation(api.records.create, { orgId, objectId: company.object._id, values: { [company.fields.name._id]: "Acme", [company.fields.notes._id]: "Old note" } });
    expect((await t.run((ctx) => ctx.db.get(acme.recordId)))!.s7).toBe("Old note");
    expect(await t.mutation(internal.seed.releaseStandardSlots, { orgId })).toEqual(["company.notes"]);
    const after = (await t.run((ctx) => ctx.db.get(acme.recordId)))!;
    expect(after.s7).toBeUndefined();
    expect(after.values[company.fields.notes._id]).toBe("Old note");
  });
});

describe("search", () => {
  it("finds a record by name past the first hundred, only in the caller's org", async () => {
    const { t, client, orgId } = await userAndOrg("A");
    const company = await objectFields(client, orgId, "company");
    for (let index = 0; index < 120; index += 1) await client.mutation(api.records.create, { orgId, objectId: company.object._id, values: { [company.fields.name._id]: `Filler ${index}` } });
    await client.mutation(api.records.create, { orgId, objectId: company.object._id, values: { [company.fields.name._id]: "Zebra Plumbing" } });
    const hits = await client.query(api.records.search, { orgId, objectId: company.object._id, text: "zebra" });
    expect(hits.map((hit: any) => hit.title)).toEqual(["Zebra Plumbing"]);
    expect(hits[0]).toMatchObject({ objectKey: "company" });
    const other = t.withIdentity({ tokenIdentifier: "clerk|B", name: "B" });
    await other.mutation(api.users.store, {});
    await expect(other.query(api.records.search, { orgId, text: "zebra" })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
  });
});
