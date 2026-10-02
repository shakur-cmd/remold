import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import { api, objectFields, userAndOrg } from "./test.helpers";

describe("demo seed", () => {
  it("creates its fictional demo exactly once and gives every record an event", async () => {
    const { client, orgId } = await userAndOrg();
    await client.mutation(api.seed.demo, { orgId }); await client.mutation(api.seed.demo, { orgId });
    const company = await objectFields(client, orgId, "company");
    const companies = await client.query(api.records.list, { orgId, objectId: company.object._id, paginationOpts: { numItems: 20, cursor: null } });
    expect(companies.page).toHaveLength(3);
    for (const key of ["company", "person", "opportunity", "project", "task", "note"]) {
      const item = await objectFields(client, orgId, key);
      const page = await client.query(api.records.list, { orgId, objectId: item.object._id, paginationOpts: { numItems: 20, cursor: null } });
      for (const record of page.page) expect((await client.query(api.events.forRecord, { orgId, recordId: record._id })).length).toBeGreaterThan(0);
    }
  });
});

describe("demo cleanup", () => {
  const titles = (t: any, orgId: any) => t.run(async (ctx: any) => (await ctx.db.query("records").collect()).filter((r: any) => r.orgId === orgId).map((r: any) => r.title).sort());

  async function seeded() {
    const setup = await userAndOrg();
    const { client, orgId } = setup;
    await client.mutation(api.seed.demo, { orgId });
    const person = await objectFields(client, orgId, "person"), company = await objectFields(client, orgId, "company");
    const people = await client.query(api.records.list, { orgId, objectId: person.object._id, paginationOpts: { numItems: 20, cursor: null } });
    const ben = people.page.find((r: any) => r.title === "Ben Sample");
    await client.mutation(api.records.update, { orgId, recordId: ben._id, values: { [person.fields.email._id]: "ben@real.example" } });
    // A real record that happens to share a demo title, made by a person after the seed.
    await client.mutation(api.records.create, { orgId, objectId: person.object._id, values: { [person.fields.name._id]: "Ava Example" } });
    await client.mutation(api.records.create, { orgId, objectId: company.object._id, values: { [company.fields.name._id]: "Real Client Inc" } });
    return setup;
  }

  it("dry run lists the untouched seed rows and the edited one it keeps, writing nothing", async () => {
    const { t, orgId } = await seeded();
    const before = await titles(t, orgId);
    const plan = await t.query(internal.seed.demoPlan, { orgId });
    expect(plan.remove).toHaveLength(15);
    expect(plan.kept).toEqual([{ id: expect.any(String), object: "person", title: "Ben Sample", reason: "edited after seeding" }]);
    expect(await titles(t, orgId)).toEqual(before);
  });

  it("deletes only untouched seed rows, each with a delete event, and keeps edited and real records", async () => {
    const { t, orgId } = await seeded();
    const result = await t.mutation(internal.seed.removeDemo, { orgId });
    expect(result.removed).toHaveLength(15);
    expect(await titles(t, orgId)).toEqual(["Ava Example", "Ben Sample", "Real Client Inc"]);
    const deletes = await t.run(async (ctx: any) => (await ctx.db.query("events").collect()).filter((e: any) => e.action === "delete"));
    expect(deletes).toHaveLength(15);
    for (const event of deletes) expect(event.actor).toEqual({ kind: "automation", id: `demo cleanup ${new Date().toISOString().slice(0, 10)}` });
    expect((await t.mutation(internal.seed.removeDemo, { orgId })).removed).toEqual([]);
  });
});
