import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const cli = join(dirname(fileURLToPath(import.meta.url)), "../../node_modules/convex/bin/main.js");

// Shared flags: --org <orgId> [--prod] [--dry-run]; anything else is positional.
export function options(argv, usage) {
  const flags = { prod: false, dryRun: false, org: null, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--prod") flags.prod = true;
    else if (argv[i] === "--dry-run") flags.dryRun = true;
    else if (argv[i] === "--org") flags.org = argv[++i] ?? null;
    else flags.rest.push(argv[i]);
  }
  if (!flags.org) { console.error(usage); process.exit(2); }
  return flags;
}

// Runs a function on the deployment configured for the current directory (or prod with --prod).
// convex run takes arguments as one command-line string, which Linux caps at 128 KiB.
export function convexRun(fn, args, prod) {
  const json = JSON.stringify(args);
  if (json.length > 120_000) { console.error("Batch is too large for one convex run call; split the file"); process.exit(2); }
  try { return JSON.parse(execFileSync(process.execPath, [cli, "run", fn, json, ...(prod ? ["--prod"] : [])], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })); }
  catch (error) { console.error(error.stderr?.trim() || error.message); process.exit(1); }
}
