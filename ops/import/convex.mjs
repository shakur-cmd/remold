import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const cli = join(dirname(fileURLToPath(import.meta.url)), "../../node_modules/convex/bin/main.js");

// Parses argv strictly, so a typo can never turn a dry run into a write: unknown
// flags, missing or flag-shaped values and surplus arguments exit 2 before Convex runs.
// `spec.values` names flags that take a value; --org is always required.
export function options(argv, spec) {
  const flags = { prod: false, dryRun: false, positional: [] }, takes = ["org", ...(spec.values ?? [])];
  const usage = (message) => { console.error(`${message}\n${spec.usage}`); process.exit(2); };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--prod") flags.prod = true;
    else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg.startsWith("--") && takes.includes(arg.slice(2))) {
      const value = argv[++i];
      if (value === undefined || value.startsWith("-")) usage(arg === "--org" ? "--org needs a workspace id" : `${arg} needs a file`);
      flags[arg.slice(2)] = value;
    } else if (arg.startsWith("-")) usage(`Unknown flag ${arg}`);
    else if (flags.positional.length < (spec.positional ?? 0)) flags.positional.push(arg);
    else usage(`Unexpected argument ${arg}`);
  }
  if (!flags.org) usage("--org <orgId> is required");
  if (!/^[a-z0-9]+$/.test(flags.org)) usage("--org needs a workspace id");
  return { ...flags, usage };
}

// Runs a function on the deployment configured for the current directory (or prod with --prod).
// convex run takes arguments as one command-line string, which Linux caps at 128 KiB.
export function convexRun(fn, args, prod) {
  const json = JSON.stringify(args);
  if (json.length > 120_000) { console.error("Too large for one convex run call; split the file"); process.exit(2); }
  try { return JSON.parse(execFileSync(process.execPath, [cli, "run", fn, json, ...(prod ? ["--prod"] : [])], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })); }
  catch (error) { console.error(error.stderr?.trim() || error.message); process.exit(1); }
}
