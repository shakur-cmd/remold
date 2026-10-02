// Deletes reviewed demo-seed rows. The dry run prints the plan (and --save writes
// its removable ids); the real run deletes exactly the ids in that file, or nothing.
// Usage: node ops/import/remove-demo.mjs --org <orgId> --dry-run [--save plan.json] [--prod]
//        node ops/import/remove-demo.mjs --org <orgId> --ids plan.json [--prod]
import { readFileSync, writeFileSync } from "node:fs";
import { convexRun, options } from "./convex.mjs";

const flags = options(process.argv.slice(2), { usage: "Usage: node ops/import/remove-demo.mjs --org <orgId> (--dry-run [--save plan.json] | --ids plan.json) [--prod]", values: ["ids", "save"] });
if (flags.dryRun === !!flags.ids) flags.usage(flags.dryRun ? "Give either --dry-run or --ids, not both" : "A real run needs --ids <file> from a reviewed dry run (--dry-run --save <file>)");
if (flags.save && !flags.dryRun) flags.usage("--save goes with --dry-run");
let ids;
if (flags.ids) {
  let plan;
  try { plan = JSON.parse(readFileSync(flags.ids, "utf8")); } catch (error) { flags.usage(`Cannot read ${flags.ids}: ${error.message}`); }
  if (plan.orgId !== flags.org) flags.usage(`${flags.ids} was made for workspace ${plan.orgId}, not ${flags.org}`);
  if (!Array.isArray(plan.ids) || plan.ids.some((id) => typeof id !== "string")) flags.usage(`${flags.ids} needs an "ids" list`);
  ids = plan.ids;
}
const row = (r) => `  ${r.object}: ${r.title}  [${r.id}${r.ref ? `, ${r.ref}` : ""}, created ${r.createdAt}]`;
console.log(`Target: ${flags.prod ? "PRODUCTION" : "dev deployment of this directory"}, org ${flags.org}`);
if (flags.dryRun) {
  const plan = convexRun("seed:demoPlan", { orgId: flags.org }, flags.prod);
  console.log(`Would remove ${plan.remove.length} (nothing written):`); for (const r of plan.remove) console.log(row(r));
  console.log(`Would keep ${plan.kept.length}:`); for (const r of plan.kept) console.log(`${row(r)}\n      ${r.reasons.join("; ")}`);
  if (flags.save) { writeFileSync(flags.save, JSON.stringify({ orgId: flags.org, ids: plan.remove.map((r) => r.id) }, null, 2) + "\n"); console.log(`Saved ${plan.remove.length} ids to ${flags.save}; review or edit it, then run with --ids ${flags.save}`); }
} else {
  const result = convexRun("seed:removeDemo", { orgId: flags.org, ids }, flags.prod);
  console.log(`Removed ${result.removed.length}:`); for (const r of result.removed) console.log(row(r));
}
