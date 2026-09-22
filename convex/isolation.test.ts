import { describe, expect, it } from "vitest";
import { api, objectFields, userAndOrg } from "./test.helpers";

describe("organization isolation", () => {
  it("does not reveal or mutate another organization's records", async () => {
    const a = await userAndOrg("a"); const b = await userAndOrg("b");
    const company = await objectFields(b.client, b.orgId, "company");
    const created = await b.client.mutation(api.records.create, { orgId: b.orgId, objectId: company.object._id, values: { [company.fields.name._id]: "B only" } });
    expect(await a.client.query(api.records.get, { orgId: a.orgId, recordId: created.recordId })).toBeNull();
    await expect(a.client.mutation(api.records.remove, { orgId: a.orgId, recordId: created.recordId })).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
    expect((await b.client.query(api.records.get, { orgId: b.orgId, recordId: created.recordId }))?.record.title).toBe("B only");
  });
});
