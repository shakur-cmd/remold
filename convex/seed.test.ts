import { describe, expect, it } from "vitest";
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
