// Imports drafted records into one workspace in one transaction; the same file twice imports once.
// Usage: node ops/import/records.mjs <file.json> --org <orgId> [--prod] [--dry-run]
import { readFileSync } from "node:fs";
import { checkBatch, batchKey } from "../../convex/lib/importCheck.ts";
import { convexRun, options } from "./convex.mjs";

const flags = options(process.argv.slice(2), "Usage: node ops/import/records.mjs <file.json> --org <orgId> [--prod] [--dry-run]");
const [file] = flags.rest;
if (!file) { console.error("Name the JSON file to import"); process.exit(2); }
let batch;
try { batch = JSON.parse(readFileSync(file, "utf8")); } catch (error) { console.error(`Cannot read ${file}: ${error.message}`); process.exit(2); }
const { records, problems } = checkBatch(batch);
if (problems.length) { console.error(`Refused before contacting Convex (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n${problems.map((p) => `  ${p}`).join("\n")}`); process.exit(1); }
console.log(`Checked locally: ${records.length} records, batch ${batchKey(records)}. Target: ${flags.prod ? "PRODUCTION" : "dev deployment of this directory"}, org ${flags.org}`);
const result = convexRun(flags.dryRun ? "imports:check" : "imports:batch", { orgId: flags.org, batch }, flags.prod);
console.log(`${flags.dryRun ? "Dry run (nothing written)" : "Import"}: ${result.status}`);
for (const [object, count] of Object.entries(result.counts)) console.log(`  ${object}: ${count}`);
