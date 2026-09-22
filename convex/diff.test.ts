import { expect, test } from "vitest";
import { api, objectFields, userAndOrg } from "./test.helpers";

test("an edit that resubmits the whole form records only the fields that actually changed, and a no-op edit writes no event", async () => {
  const { client, orgId } = await userAndOrg();
  const company = await objectFields(client, orgId, "company");
  const name = company.fields.name._id, city = company.fields.city._id, domain = company.fields.domain._id;
  const { recordId } = await client.mutation(api.records.create, { orgId, objectId: company.object._id, values: { [name]: "Fictional Plumbing Co", [city]: "Fabletown" } });

  await client.mutation(api.records.update, { orgId, recordId, values: { [name]: "Fictional Plumbing Co", [city]: "Fabletown", [domain]: "testing.example" } });
  const [latest] = await client.query(api.events.forRecord, { orgId, recordId });
  expect(latest.action).toBe("update");
  expect(Object.keys(latest.after!)).toEqual([domain]);
  expect(latest.before).toEqual({ [domain]: null });

  const countBefore = (await client.query(api.events.forRecord, { orgId, recordId })).length;
  await client.mutation(api.records.update, { orgId, recordId, values: { [name]: "Fictional Plumbing Co", [city]: "Fabletown", [domain]: "testing.example" } });
  expect((await client.query(api.events.forRecord, { orgId, recordId })).length).toBe(countBefore);
});
