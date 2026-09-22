import { describe, expect, it } from "vitest";
import { api, objectFields, userAndOrg } from "./test.helpers";

describe("related records", () => {
  it("returns lookup and link relationships and cleans links on delete", async () => {
    const { t, client, orgId } = await userAndOrg();
    const company = await objectFields(client, orgId, "company"); const person = await objectFields(client, orgId, "person"); const task = await objectFields(client, orgId, "task");
    const acme = await client.mutation(api.records.create, { orgId, objectId: company.object._id, values: { [company.fields.name._id]: "Acme" } });
    await client.mutation(api.records.create, { orgId, objectId: person.object._id, values: { [person.fields.name._id]: "Ada", [person.fields.company._id]: acme.recordId } });
    expect((await client.query(api.records.related, { orgId, recordId: acme.recordId, fieldId: person.fields.company._id, paginationOpts: { numItems: 10, cursor: null } })).page).toHaveLength(1);
    const blocker = await client.mutation(api.records.create, { orgId, objectId: task.object._id, values: { [task.fields.title._id]: "Blocker" } });
    const blocked = await client.mutation(api.records.create, { orgId, objectId: task.object._id, values: { [task.fields.title._id]: "Blocked", [task.fields.blockedBy._id]: [blocker.recordId] } });
    expect((await client.query(api.records.related, { orgId, recordId: blocker.recordId, fieldId: task.fields.blockedBy._id, paginationOpts: { numItems: 10, cursor: null } })).page.map((record: any) => record?._id)).toContain(blocked.recordId);
    await client.mutation(api.records.remove, { orgId, recordId: blocker.recordId });
    expect(await t.run((ctx) => ctx.db.query("links").withIndex("by_from", (q) => q.eq("orgId", orgId).eq("fieldId", task.fields.blockedBy._id).eq("fromRecordId", blocked.recordId)).collect())).toEqual([]);
  });
});
