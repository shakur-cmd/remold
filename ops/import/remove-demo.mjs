// Deletes the untouched rows the demo seed created; edited and real rows stay.
// Usage: node ops/import/remove-demo.mjs --org <orgId> [--prod] [--dry-run]
import { convexRun, options } from "./convex.mjs";

const flags = options(process.argv.slice(2), "Usage: node ops/import/remove-demo.mjs --org <orgId> [--prod] [--dry-run]");
console.log(`Target: ${flags.prod ? "PRODUCTION" : "dev deployment of this directory"}, org ${flags.org}`);
const result = flags.dryRun ? convexRun("seed:demoPlan", { orgId: flags.org }, flags.prod) : convexRun("seed:removeDemo", { orgId: flags.org }, flags.prod);
const removed = result.remove ?? result.removed;
console.log(`${flags.dryRun ? "Would remove" : "Removed"} ${removed.length} demo rows:`);
for (const row of removed) console.log(`  ${row.object}: ${row.title}`);
console.log(`Kept ${result.kept.length}:`);
for (const row of result.kept) console.log(`  ${row.object}: ${row.title} (${row.reason})`);
