import { describe, expect, it } from "vitest";
import { api, objectFields, userAndOrg } from "./test.helpers";

describe("applyChange", () => {
  it("writes records, projections, events, updates, and deletes linked rows", async () => {
    const { t, client, orgId } = await userAndOrg();
    const task = await objectFields(client, orgId, "task");
    const first = await client.mutation(api.records.create, { orgId, objectId: task.object._id, values: { [task.fields.title._id]: "First" } });
    const second = await client.mutation(api.records.create, { orgId, objectId: task.object._id, values: { [task.fields.title._id]: "Second", [task.fields.blockedBy._id]: [first.recordId] } });
    const before = await client.query(api.events.forRecord, { orgId, recordId: second.recordId });
    expect(before[0]).toMatchObject({ before: null, after: { [task.fields.title._id]: "Second" }, actor: { kind: "user" } });
    await client.mutation(api.records.update, { orgId, recordId: second.recordId, values: { [task.fields.title._id]: "Renamed" } });
    const updated = await client.query(api.events.forRecord, { orgId, recordId: second.recordId });
    expect(updated[0]).toMatchObject({ before: { [task.fields.title._id]: "Second" }, after: { [task.fields.title._id]: "Renamed" } });
    await client.mutation(api.records.remove, { orgId, recordId: first.recordId });
    expect(await t.run((ctx) => ctx.db.query("links").withIndex("by_from", (q) => q.eq("orgId", orgId).eq("fieldId", task.fields.blockedBy._id).eq("fromRecordId", second.recordId)).collect())).toEqual([]);
  });
  it("rejects bad values without writing a record or event", async () => {
    const { client, orgId } = await userAndOrg();
    const opportunity = await objectFields(client, orgId, "opportunity");
    const before = await client.query(api.events.forOrg, { orgId, paginationOpts: { numItems: 100, cursor: null } });
    await expect(client.mutation(api.records.create, { orgId, objectId: opportunity.object._id, values: { [opportunity.fields.name._id]: "Bad", [opportunity.fields.stage._id]: "nope" } })).rejects.toMatchObject({ data: { code: "VALIDATION", fieldId: opportunity.fields.stage._id } });
    const after = await client.query(api.events.forOrg, { orgId, paginationOpts: { numItems: 100, cursor: null } });
    expect(after.page).toEqual(before.page);
  });
});
