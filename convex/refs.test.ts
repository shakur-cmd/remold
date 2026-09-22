import { expect, test } from "vitest";
import { api, objectFields, userAndOrg } from "./test.helpers";
import { internal } from "./_generated/api";

test("every new record gets a unique three-word code that finds it again, case and space insensitive", async () => {
  const { t, client, orgId } = await userAndOrg();
  const company = await objectFields(client, orgId, "company");
  const ids = await Promise.all(
    ["One", "Two", "Three"].map((name) => client.mutation(api.records.create, { orgId, objectId: company.object._id, values: { [company.fields.name._id]: name } })),
  );
  const refs = await Promise.all(ids.map(async ({ recordId }) => (await client.query(api.records.get, { orgId, recordId }))!.record.ref!));
  expect(refs.every((ref) => /^[a-z]+-[a-z]+-[a-z]+$/.test(ref))).toBe(true);
  expect(new Set(refs).size).toBe(3);
  const found = await client.query(api.records.byRef, { orgId, ref: ` ${refs[1]!.toUpperCase()} ` });
  expect(found?.record._id).toBe(ids[1]!.recordId);
  expect(await client.query(api.records.byRef, { orgId, ref: "no-such-code" })).toBeNull();

  // Another org cannot resolve this org's code.
  const other = await userAndOrg("B");
  expect(await other.client.query(api.records.byRef, { orgId: other.orgId, ref: refs[0]! })).toBeNull();

  // Records that predate codes are backfilled once.
  await t.run(async (ctx) => ctx.db.patch(ids[0]!.recordId, { ref: undefined }));
  expect(await t.mutation(internal.seed.backfillRefs, { orgId })).toBe(1);
  expect(await t.mutation(internal.seed.backfillRefs, { orgId })).toBe(0);
});

test("ensureStandard adds new standard fields to an existing org without touching what is there", async () => {
  const { t, client, orgId } = await userAndOrg();
  const before = await objectFields(client, orgId, "company");
  await t.run(async (ctx) => ctx.db.delete(before.fields.country._id));
  await t.mutation(internal.seed.ensureStandard, { orgId });
  const after = await objectFields(client, orgId, "company");
  expect(Object.keys(after.fields).sort()).toEqual(Object.keys(before.fields).sort());
  expect(after.fields.name._id).toBe(before.fields.name._id);
  expect(after.fields.country.slot).toBeDefined();
});
