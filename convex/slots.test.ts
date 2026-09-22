import { describe, expect, it } from "vitest";
import { api, userAndOrg } from "./test.helpers";

describe("slots", () => {
  it("allocates eight number slots, never reuses retired slots, and rejects unindexed sorting", async () => {
    const { client, orgId } = await userAndOrg();
    const objectId = await client.mutation(api.objects.create, { orgId, key: "metric", label: "Metric", labelPlural: "Metrics" });
    const made = [] as any[];
    for (let index = 0; index < 9; index += 1) made.push(await client.mutation(api.fields.create, { orgId, objectId, key: `number${index}`, label: `Number ${index}`, type: "number" }));
    expect(made.map((field) => field.slot?.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, undefined]);
    await client.mutation(api.fields.retire, { orgId, fieldId: made[0].fieldId });
    const next = await client.mutation(api.fields.create, { orgId, objectId, key: "later", label: "Later", type: "number" });
    expect(next.slot).toBeUndefined();
    await expect(client.query(api.records.list, { orgId, objectId, sort: { fieldId: made[8].fieldId, direction: "asc" }, paginationOpts: { numItems: 50, cursor: null } })).rejects.toMatchObject({ data: { code: "UNINDEXED_FIELD" } });
  });
});
