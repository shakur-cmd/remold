import { writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { fixture, expected, type ManifestRow } from "./fixture.ts";
import { deployment, run, scope, type Option } from "./cli.ts";

const target = deployment();
if (process.argv.includes("--reset")) throw new Error("No destructive reset in this spike. Use a fresh dedicated dev deployment.");
const rows = fixture();
const manifest = {} as Record<Option, ManifestRow[]>;
for (const option of ["slots", "values"] as const) {
  manifest[option] = [];
  for (let offset = 0; offset < rows.length; offset += 100) {
    run("bench:seedBatch", { ...scope(option), rows: rows.slice(offset, offset + 100) });
    if (offset % 5000 === 0) console.log(`${option}: ${offset + 100} / ${rows.length}`);
  }
  let cursor: string | null = null;
  for (;;) {
    const result: { page: ManifestRow[]; isDone: boolean; continueCursor: string } = run("bench:inventory", { ...scope(option), cursor });
    manifest[option].push(...result.page);
    if (result.isDone) break;
    cursor = result.continueCursor;
  }
  assert.equal(manifest[option].length, 50_000);
  for (let i = 0; i < rows.length; i++) {
    assert.equal(manifest[option][i]!.sourceId, rows[i]!.sourceId);
    assert.deepEqual(manifest[option][i]!.values, rows[i]!.values);
  }
}
writeFileSync("bench/manifest.json", JSON.stringify({ deployment: target, manifest }));
writeFileSync("bench/expected.json", JSON.stringify({ deployment: target, slots: expected(manifest.slots), values: expected(manifest.values) }, null, 2));
console.log("Both options contain exactly 50,000 independently reconciled records. Expected IDs saved.");
