import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";
import { fixture, expected, type ManifestRow } from "./fixture";
// convex-test locates the function root from any module path under _generated.
const modules = { "../convex/bench.ts": () => import("../convex/bench"), "../convex/_generated/api.js": () => import("../convex/_generated/api.js") };
const { page, seedBatch: seed, removeRecovery: cleanup, seedRange, inventory } = internal.bench;
for (const option of ["slots", "values"] as const) describe(option, () => {
  test("custom score sorting, selective stage filters and cursor page match independent fixture order", async () => {
    const t = convexTest(schema, modules);
    const rows = await t.run(async ctx => {
      const manifest: ManifestRow[] = [];
      for (const row of fixture(200)) {
        const common = { ...row, orgId: "demo", objectKey: "customJob" };
        if (option === "slots") {
          const id = await ctx.db.insert("slotRecords", { ...common, n0: row.values.score, s0: row.values.stage });
          const doc = (await ctx.db.get(id))!;
          manifest.push({ ...row, _id: id, _creationTime: doc._creationTime });
        } else {
          const id = await ctx.db.insert("valueRecords", common);
          const doc = (await ctx.db.get(id))!;
          for (const [fieldId, value] of Object.entries(row.values)) await ctx.db.insert("recordValues", {
            orgId: "demo", objectKey: "customJob", fieldId, value, recordId: id, recordCreatedTime: doc._creationTime,
          });
          manifest.push({ ...row, _id: id, _creationTime: doc._creationTime });
        }
      }
      return manifest;
    });
    const oracle = expected(rows);
    const args = { option, orgId: "demo", objectKey: "customJob", cursor: null };
    const first = await t.query(page, { ...args, query: "score" });
    expect(first.page.map(r => r._id)).toEqual(oracle.score);
    const second = await t.query(page, { ...args, query: "score", cursor: first.continueCursor });
    expect(second.page.map(r => r._id)).toEqual(oracle.page2);
    for (const query of ["won", "contacted"] as const) {
      const result = await t.query(page, { ...args, query });
      expect(result.page.map(r => r._id)).toEqual(oracle[query]);
    }
    expect((await t.query(page, { ...args, query: "score", orgId: "other" })).page).toEqual([]);
    expect((await t.query(page, { ...args, query: "score", objectKey: "other" })).page).toEqual([]);
  });
});

for (const option of ["slots", "values"] as const) {
  test(`${option}: repeated seed is idempotent, conflicting seed rolls back, recovery record wins then cleans up`, async () => {
    const t = convexTest(schema, modules);
    const scope = { option, orgId: "remold-benchmark", objectKey: "customJob" };
    const rows = fixture(2);
    rows[0]!.values.score = 9999;
    rows[1]!.values.score = 9999;
    const original = await t.mutation(seed, { ...scope, rows });
    expect(await t.mutation(seed, { ...scope, rows })).toEqual(original);
    const before = await t.query(page, { ...scope, query: "score", cursor: null });
    expect(before.page).toHaveLength(2);
    expect(before.page.map(r => r._id)).toEqual(expected(original.map((r, i) => ({ ...r, values: rows[i]!.values }))).score);
    await expect(t.mutation(seed, { ...scope, rows: [{ ...rows[0], values: { ...rows[0]!.values, score: 7 } }] })).rejects.toThrow("different values");
    expect((await t.query(page, { ...scope, query: "score", cursor: null })).page).toEqual(before.page);
    const recovery = fixture(1)[0]!;
    recovery.sourceId = 50_001;
    recovery.values.score = 10_000;
    const added = await t.mutation(seed, { ...scope, rows: [recovery] });
    const after = await t.query(page, { ...scope, query: "score", cursor: null });
    expect(after.page.map(r => r._id)).toEqual([added[0]._id, ...before.page.map(r => r._id)]);
    await t.mutation(cleanup, scope);
    expect((await t.query(page, { ...scope, query: "score", cursor: null })).page).toEqual(before.page);
    await t.mutation(cleanup, scope);
    if (option === "values") expect(await t.run(ctx => ctx.db.query("recordValues").collect())).toHaveLength(24);
    await expect(t.mutation(cleanup, { ...scope, orgId: "someone-else" })).rejects.toThrow("Not the benchmark scope");
  });
}

for (const option of ["slots", "values"] as const) {
  test(`${option}: server-side seeding writes the whole fixture once, resumes as a no-op, and refuses a different fixture`, async () => {
    const t = convexTest(schema, modules);
    const scope = { option, orgId: "remold-benchmark", objectKey: "customJob" };
    expect(await t.action(seedRange, { ...scope, offset: 0, limit: 150, total: 250 })).toBe(150);
    expect(await t.action(seedRange, { ...scope, offset: 150, limit: 5_000, total: 250 })).toBe(100);
    const first = await t.query(inventory, { ...scope, cursor: null });
    expect(first.page.map(r => r.values)).toEqual(fixture(250).map(r => r.values));
    expect(await t.action(seedRange, { ...scope, offset: 0, limit: 250, total: 250 })).toBe(250);
    expect((await t.query(inventory, { ...scope, cursor: null })).page).toEqual(first.page);
    // A different total shuffles stages differently, so the same source IDs carry different values.
    await expect(t.action(seedRange, { ...scope, offset: 0, limit: 100, total: 300 })).rejects.toThrow("different values");
    expect((await t.query(inventory, { ...scope, cursor: null })).page).toEqual(first.page);
  });
}
