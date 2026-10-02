import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A copy of the scripts whose Convex CLI is a stub that records every call, so a
// test can tell whether anything would have reached a deployment.
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "remold-import-cli-"));
  mkdirSync(join(root, "ops"), { recursive: true }); mkdirSync(join(root, "convex/lib"), { recursive: true }); mkdirSync(join(root, "node_modules/convex/bin"), { recursive: true });
  cpSync(join(process.cwd(), "ops/import"), join(root, "ops/import"), { recursive: true });
  cpSync(join(process.cwd(), "convex/lib/importCheck.ts"), join(root, "convex/lib/importCheck.ts"));
  const calls = join(root, "calls.jsonl");
  writeFileSync(join(root, "node_modules/convex/bin/main.js"), `require("node:fs").appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n"); console.log(JSON.stringify({ status: "ready", counts: {}, remove: [], removed: [], kept: [] }));`);
  writeFileSync(join(root, "node_modules/convex/package.json"), '{"type":"commonjs"}');
  writeFileSync(join(root, "batch.json"), JSON.stringify({ records: [{ tmpId: "c", object: "company", values: { name: "C" } }] }));
  writeFileSync(join(root, "ids.json"), JSON.stringify({ orgId: ORG, ids: ["k1"] }));
  const run = (script: string, ...args: string[]) => {
    const result = spawnSync(process.execPath, [join(root, "ops/import", script), ...args], { cwd: root, encoding: "utf8" });
    return { status: result.status, stderr: result.stderr, calls: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [] };
  };
  return { root, run };
}
const ORG = "px7fqrk1c98d49apjets54yr618fhzyy";

// Each case spawns Node, so these get more time than the 5 s default.
describe("import and cleanup commands", () => {
  it("refuse malformed invocations before calling Convex at all", () => {
    const { root, run } = sandbox();
    const batch = join(root, "batch.json"), ids = join(root, "ids.json");
    const malformed: [string, string[], RegExp][] = [
      ["records.mjs", [batch, "--org", ORG, "--dryrun"], /Unknown flag --dryrun/],
      ["records.mjs", [batch, "--org", ORG, "--prod", "--dry_run"], /Unknown flag --dry_run/],
      ["records.mjs", [batch, batch, "--org", ORG], /Unexpected argument/],
      ["records.mjs", ["--org", ORG], /Name the JSON file/],
      ["records.mjs", [batch], /--org <orgId> is required/],
      ["records.mjs", [batch, "--org", "--dry-run"], /--org needs a workspace id/],
      ["records.mjs", [batch, "--org"], /--org needs a workspace id/],
      ["records.mjs", [batch, "--org", ORG, "--ids", ids], /Unknown flag --ids/],
      ["remove-demo.mjs", ["--org", ORG, "--prod", "--dryrun"], /Unknown flag --dryrun/],
      ["remove-demo.mjs", ["--org", ORG, "--prod"], /needs --ids/],
      ["remove-demo.mjs", ["--org", ORG, "extra", "--dry-run"], /Unexpected argument/],
      ["remove-demo.mjs", ["--org", ORG, "--ids", "--prod"], /--ids needs a file/],
      ["remove-demo.mjs", ["--org", ORG, "--dry-run", "--ids", ids], /either --dry-run or --ids/],
      ["remove-demo.mjs", ["--org", "kxotherorg000000000000000000000", "--ids", ids], /made for workspace/],
    ];
    for (const [script, args, message] of malformed) {
      const result = run(script, ...args);
      expect(result.status, args.join(" ")).toBe(2);
      expect(result.stderr, args.join(" ")).toMatch(message);
    }
    expect(run("records.mjs", batch, "--org", ORG, "--dryrun").calls).toEqual([]);
  }, 60_000);

  it("send a well-formed dry run to the read-only function and --prod only when given", () => {
    const { root, run } = sandbox();
    const batch = join(root, "batch.json"), ids = join(root, "ids.json"), saved = join(root, "saved.json");
    expect(run("records.mjs", batch, "--org", ORG, "--dry-run").status).toBe(0);
    expect(run("records.mjs", batch, "--prod", "--org", ORG).status).toBe(0);
    expect(run("remove-demo.mjs", "--org", ORG, "--dry-run", "--save", saved).status).toBe(0);
    expect(run("remove-demo.mjs", "--org", ORG, "--ids", ids, "--prod").status).toBe(0);
    const calls = run("records.mjs", batch, "--org", ORG, "--dry-run").calls.map((call: string[]) => [call[1], call.includes("--prod")]);
    expect(calls).toEqual([["imports:check", false], ["imports:batch", true], ["seed:demoPlan", false], ["seed:removeDemo", true], ["imports:check", false]]);
    expect(JSON.parse(readFileSync(saved, "utf8"))).toEqual({ orgId: ORG, ids: [] });
  }, 60_000);
});
