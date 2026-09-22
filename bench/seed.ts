import { writeFileSync } from "node:fs";
import { expected } from "./fixture.ts";
import { deployment, run, scope, reconciled } from "./cli.ts";

const target = deployment();
if (process.argv.includes("--reset")) throw new Error("No destructive reset in this spike. Use a fresh dedicated dev deployment.");
const total = 50_000;
const oracle: Record<string, unknown> = { deployment: target };
for (const option of ["slots", "values"] as const) {
  // Rows are generated and written server-side. Each call is idempotent, so a
  // killed seed resumes by rerunning this script.
  for (let offset = 0; offset < total; offset += 5_000) {
    run("bench:seedRange", { ...scope(option), offset, limit: 5_000, total });
    console.log(`${option}: ${offset + 5_000} / ${total}`);
  }
  oracle[option] = expected(reconciled(option));
}
writeFileSync("bench/expected.json", JSON.stringify(oracle, null, 2));
console.log("Both options contain exactly 50,000 independently reconciled records. Expected IDs saved to bench/expected.json.");
