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
  const list = async (client: any, orgId: any, key: string) => { const item = await objectFields(client, orgId, key); return { ...item, page: (await client.query(api.records.list, { orgId, objectId: item.object._id, paginationOpts: { numItems: 50, cursor: null } })).page }; };
  const snapshot = (t: any, orgId: any) => t.run(async (ctx: any) => ({
    records: (await ctx.db.query("records").collect()).filter((r: any) => r.orgId === orgId).map((r: any) => ({ id: r._id, title: r.title, values: r.values, updatedAt: r.updatedAt })).sort((a: any, b: any) => a.id.localeCompare(b.id)),
    events: (await ctx.db.query("events").collect()).length, links: (await ctx.db.query("links").collect()).length,
  }));
  const ids = (plan: any) => plan.remove.map((row: any) => row.id);

  // Ben is edited with the reason the system uses for its own clean-ups; a real
  // person, deal and task point at demo rows.
  async function seeded() {
    const setup = await userAndOrg();
    const { client, orgId } = setup;
    await client.mutation(api.seed.demo, { orgId });
    const people = await list(client, orgId, "person"), companies = await list(client, orgId, "company"), deals = await list(client, orgId, "opportunity");
    const ben = people.page.find((r: any) => r.title === "Ben Sample"), fictional = companies.page.find((r: any) => r.title === "Fictional Plumbing Co"), atlas = companies.page.find((r: any) => r.title === "Atlas Imaginary Works");
    await client.mutation(api.records.update, { orgId, recordId: ben._id, values: { [people.fields.email._id]: "ben@real.example" }, reason: "Linked record was deleted" });
    const real = await client.mutation(api.records.create, { orgId, objectId: people.object._id, values: { [people.fields.name._id]: "Real Person", [people.fields.company._id]: atlas._id } });
    await client.mutation(api.records.create, { orgId, objectId: deals.object._id, values: { [deals.fields.name._id]: "Real deal", [deals.fields.person._id]: real.recordId } });
    // A real task blocked by a demo task: a links reference, not a lookup.
    const tasks = await list(client, orgId, "task"), review = tasks.page.find((r: any) => r.title === "Review fictional brief");
    await client.mutation(api.records.create, { orgId, objectId: tasks.object._id, values: { [tasks.fields.title._id]: "Real task", [tasks.fields.blockedBy._id]: [review._id] } });
    const project = (await list(client, orgId, "project")).page[0];
    return { ...setup, ben, fictional, atlas, review, project, real: real.recordId };
  }

  it("dry run plans every untouched seed-titled row and says why each other one stays, writing nothing", async () => {
    const { t, orgId, ben, fictional, atlas, review, project } = await seeded();
    const before = await snapshot(t, orgId);
    const plan = await t.query(internal.seed.demoPlan, { orgId });
    const kept = Object.fromEntries(plan.kept.map((row: any) => [row.title, row.reasons]));
    expect(kept["Ben Sample"]).toEqual(["has events other than its create"]);
    expect(kept["Atlas Imaginary Works"]).toEqual(["referenced by a record outside the plan"]);
    // Kept Ben still points at Fictional Plumbing Co, so that stays too.
    expect(kept["Fictional Plumbing Co"]).toEqual(["referenced by a record outside the plan"]);
    expect(kept["Review fictional brief"]).toEqual(["referenced by a record outside the plan"]);
    // The kept task's project, and so on.
    expect(kept["Fictional Plumbing Refresh"]).toEqual(["referenced by a record outside the plan"]);
    expect(plan.kept.map((row: any) => row.id).sort()).toEqual([ben._id, fictional._id, atlas._id, review._id, project._id].sort());
    expect(plan.remove).toHaveLength(11);
    for (const row of plan.remove) expect(row).toMatchObject({ id: expect.any(String), object: expect.any(String), title: expect.any(String) });
    expect(await snapshot(t, orgId)).toEqual(before);
  });

  it("deletes exactly the planned ids and changes nothing outside them", async () => {
    const { t, orgId } = await seeded();
    const planned = ids(await t.query(internal.seed.demoPlan, { orgId }));
    const before = await snapshot(t, orgId);
    const result = await t.mutation(internal.seed.removeDemo, { orgId, ids: planned });
    expect(result.removed.map((row: any) => row.id).sort()).toEqual([...planned].sort());
    const after = await snapshot(t, orgId);
    expect(after.records).toEqual(before.records.filter((r: any) => !planned.includes(r.id)));
    const deletes = await t.run(async (ctx: any) => (await ctx.db.query("events").collect()).filter((e: any) => e.action !== "create" && e.actor.kind === "automation"));
    expect(deletes.map((e: any) => e.action)).toEqual(planned.map(() => "delete"));
    for (const event of deletes) expect(event.actor).toEqual({ kind: "automation", id: `demo cleanup ${new Date().toISOString().slice(0, 10)}` });
  });

  it("refuses the whole run if any listed record fails the checks at run time", async () => {
    const { t, client, orgId, ben, atlas, review, real } = await seeded();
    const planned = ids(await t.query(internal.seed.demoPlan, { orgId }));
    const before = await snapshot(t, orgId);
    const refused = (list: string[]) => t.mutation(internal.seed.removeDemo, { orgId, ids: list }).catch((e: any) => e.data?.message ?? String(e));
    expect(await refused([...planned, ben._id])).toContain("Ben Sample (person): has events other than its create");
    expect(await refused([...planned, atlas._id])).toContain("Atlas Imaginary Works (company): referenced by a record outside the plan");
    expect(await refused([...planned, review._id])).toContain("Review fictional brief (task): referenced by a record outside the plan");
    expect(await refused([...planned, real])).toContain("Real Person (person): title/object not in the seed list");
    // Edited between the dry run and the real run.
    const tasks = await list(client, orgId, "task");
    await client.mutation(api.records.update, { orgId, recordId: planned.find((id: string) => tasks.page.some((r: any) => r._id === id)), values: { [tasks.fields.done._id]: true } });
    const afterEdit = await snapshot(t, orgId);
    expect(afterEdit.events).toBe(before.events + 1);
    expect(await refused(planned)).toContain("has events other than its create");
    expect(await snapshot(t, orgId)).toEqual(afterEdit);
  });
});
