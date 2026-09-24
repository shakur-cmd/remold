import { expect, it } from "vitest";
import { internal } from "./_generated/api";
import { api, userAndOrg } from "./test.helpers";
import { enabled, setFlag } from "./ops";

it("defaults missing flags to disabled and scopes operator changes to one organization", async () => {
  const { t, client, orgId } = await userAndOrg();
  const b = t.withIdentity({ tokenIdentifier: "clerk|B", name: "B" });
  await b.mutation(api.users.store, {});
  const orgB = await b.mutation(api.orgs.create, { name: "B Org" });
  const beforeB = await b.query(api.orgs.get, { orgId: orgB });
  expect(await t.run((ctx) => enabled(ctx, orgId, "campaigns"))).toBe(false);
  await t.mutation(internal.ops.setFlag, { orgId, flag: "campaigns", enabled: true, reason: "release-check" });
  expect((await client.query(api.orgs.get, { orgId })).flags?.campaigns).toBe(true);
  await t.mutation(internal.ops.setFlag, { orgId, flag: "tasks", enabled: true, reason: "release-check" });
  expect(await t.run((ctx) => enabled(ctx, orgId, "campaigns"))).toBe(true);
  expect(await t.run((ctx) => enabled(ctx, orgId, "unreleased"))).toBe(false);
  expect(await t.run((ctx) => enabled(ctx, orgB, "campaigns"))).toBe(false);
  expect(await b.query(api.orgs.get, { orgId: orgB })).toEqual(beforeB);
  await expect(b.query(api.orgs.get, { orgId })).rejects.toThrow(/Membership required/);
  await expect(t.query(api.orgs.get, { orgId })).rejects.toThrow(/Sign in first/);
  expect(await t.run((ctx) => ctx.db.query("opsEvents").withIndex("by_org", q => q.eq("orgId", orgB)).collect())).toEqual([]);
});

it("audits real flag transitions with internal operator origin and keeps retries idempotent", async () => {
  const { t, orgId } = await userAndOrg();
  const turnOn = { orgId, flag: "campaigns", enabled: true, reason: "release-check" };
  await t.mutation(internal.ops.setFlag, turnOn);
  await t.mutation(internal.ops.setFlag, turnOn);
  await t.mutation(internal.ops.setFlag, { ...turnOn, enabled: false, reason: "rollback-check" });
  expect(await t.run((ctx) => enabled(ctx, orgId, "campaigns"))).toBe(false);
  const events = await t.run((ctx) => ctx.db.query("opsEvents").withIndex("by_org", q => q.eq("orgId", orgId)).collect());
  expect(events.map(({ _id, _creationTime, ...event }) => event)).toEqual([
    { orgId, actor: { kind: "operator", id: "internal-admin" }, action: "featureFlagChanged", flag: "campaigns", before: false, after: true, reason: "release-check" },
    { orgId, actor: { kind: "operator", id: "internal-admin" }, action: "featureFlagChanged", flag: "campaigns", before: true, after: false, reason: "rollback-check" },
  ]);
});

it("rejects client attempts to smuggle flags through organization create and rename", async () => {
  const { t, client, orgId } = await userAndOrg();
  const before = await client.query(api.orgs.get, { orgId });
  // Deliberately exercise untyped client payloads, not just compile-time exclusion.
  await expect(client.mutation(api.orgs.create, { name: "Forged", flags: { campaigns: true } } as never)).rejects.toThrow();
  await expect(client.mutation(api.orgs.rename, { orgId, name: "Forged", flags: { campaigns: true } } as never)).rejects.toThrow();
  expect(await client.query(api.orgs.get, { orgId })).toEqual(before);
  expect(await client.query(api.orgs.mine, {})).toHaveLength(1);
  expect(await t.run(ctx => ctx.db.query("opsEvents").collect())).toEqual([]);
  // convex-test permits internal calls; the real unauthenticated HTTP probe remains required.
  expect(setFlag.isInternal).toBe(true);
  expect("isPublic" in setFlag && setFlag.isPublic).not.toBe(true);
});

it("refuses unknown organizations and invalid operational references without side effects", async () => {
  const { t, client, orgId } = await userAndOrg();
  const removedOrg = await client.mutation(api.orgs.create, { name: "Temporary" });
  await t.run(ctx => ctx.db.delete(removedOrg));
  const change = { orgId, flag: "campaigns", enabled: true, reason: "release-check" };
  await expect(t.mutation(internal.ops.setFlag, { ...change, orgId: removedOrg })).rejects.toThrow(/Organization not found/);
  for (const invalid of [{ reason: "" }, { reason: "Customer private content" }, { flag: "__proto__" }, { flag: "a".repeat(65) }]) {
    await expect(t.mutation(internal.ops.setFlag, { ...change, ...invalid })).rejects.toThrow();
  }
  expect((await client.query(api.orgs.get, { orgId })).flags).toBeUndefined();
  expect(await t.run(ctx => ctx.db.query("opsEvents").collect())).toEqual([]);
});
