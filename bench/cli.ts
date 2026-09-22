import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import { fixture, type ManifestRow } from "./fixture.ts";

// Call the Convex CLI through node directly. Going through `pnpm exec` needs a
// shell on Windows, and a shell mangles the JSON argument.
const convexBin = join(dirname(createRequire(import.meta.url).resolve("convex/package.json")), "bin/main.js");

export function deployment() {
  const fileEnv = Object.assign({}, ...[".env", ".env.local"].map(path => existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : {})) as Record<string, string>;
  if (["CONVEX_DEPLOY_KEY", "CONVEX_SELF_HOSTED_URL", "CONVEX_SELF_HOSTED_ADMIN_KEY"].some(key => process.env[key] || fileEnv[key])) {
    throw new Error("Remove deployment-key and self-host overrides; the spike uses your logged-in Cloud dev deployment only.");
  }
  const value = process.env.CONVEX_DEPLOYMENT ?? fileEnv.CONVEX_DEPLOYMENT;
  if (!value?.startsWith("dev:")) throw new Error("This spike requires a dedicated Convex Cloud dev deployment, never production.");
  return value;
}
export function run<T>(name: string, args: object): T {
  const output = execFileSync(process.execPath, [convexBin, "run", name, JSON.stringify(args)], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  // Convex CLI suppresses output for a successful null/void return.
  return (output.trim() === "" ? null : JSON.parse(output)) as T;
}
export function streamLogs(fd: number) {
  return spawn(process.execPath, [convexBin, "logs", "--jsonl", "--success"], { stdio: ["ignore", fd, "inherit"] });
}
export type Option = "slots" | "values";
export const scope = (option: Option) => ({ option, orgId: "remold-benchmark", objectKey: "customJob" });

// Every stored record in source-ID order, checked field by field against the
// fixture. Both scripts start here so neither trusts a file from a previous run.
export function reconciled(option: Option, rows = fixture()) {
  const records: ManifestRow[] = [];
  let cursor: string | null = null;
  for (;;) {
    const result: { page: ManifestRow[]; isDone: boolean; continueCursor: string } = run("bench:inventory", { ...scope(option), cursor });
    records.push(...result.page);
    if (result.isDone) break;
    cursor = result.continueCursor;
  }
  assert.equal(records.length, rows.length, `${option}: expected exactly ${rows.length} records, found ${records.length}. Never benchmark an old fixture or an interrupted recovery.`);
  for (let i = 0; i < rows.length; i++) {
    assert.equal(records[i]!.sourceId, rows[i]!.sourceId);
    assert.deepEqual(records[i]!.values, rows[i]!.values);
  }
  return records;
}
