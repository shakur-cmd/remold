import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, symlinkSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scratch = mkdtempSync(join(tmpdir(), "remold-rate-service-"));
const sha = (s) => createHash("sha256").update(s).digest("hex");
const configHash = () => existsSync(join(root, ".env.local")) ? sha(readFileSync(join(root, ".env.local"))) : null;
const liveEnvHash = configHash();
const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CONVEX_AGENT_MODE: "anonymous", CI: "1" };
cpSync(join(root, "convex"), join(scratch, "convex"), { recursive: true, filter: (p) => !p.endsWith(".test.ts") && !p.endsWith("test.helpers.ts") && !p.endsWith("test.setup.ts") });
cpSync(join(root, "ops/rehearsal/rate-fixture.ts"), join(scratch, "convex/rateFixture.ts"));
writeFileSync(join(scratch, "convex/auth.config.ts"), "export default { providers: [] };\n");
writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "remold-rate-proof", private: true, type: "module", dependencies: { convex: "1.46.0", "@convex-dev/rate-limiter": "0.4.0" } }));
symlinkSync(join(root, "node_modules"), join(scratch, "node_modules"), "dir");
const cli = join(root, "node_modules/convex/bin/main.js");
let logs = "";
const backend = spawn(process.execPath, [cli, "dev", "--typecheck", "disable", "--tail-logs", "disable", "--local-cloud-port", "3420", "--local-site-port", "3421"], { cwd: scratch, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
backend.stdout.on("data", (b) => { logs += b; });
backend.stderr.on("data", (b) => { logs += b; });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (fn, args = {}) => JSON.parse(execFileSync(process.execPath, [cli, "run", fn, JSON.stringify(args)], { cwd: scratch, env, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] }));
try {
  const deadline = Date.now() + 180_000;
  while (!/Convex functions ready/.test(logs)) {
    if (backend.exitCode !== null || Date.now() > deadline) throw new Error(`Local backend failed to become ready. Log retained at ${scratch}/backend.log`);
    await pause(250);
  }
  const config = readFileSync(join(scratch, ".env.local"), "utf8");
  const url = /^CONVEX_URL=(.+)$/m.exec(config)?.[1];
  assert.ok(url && ["127.0.0.1", "localhost"].includes(new URL(url).hostname), "Refusing non-loopback proof deployment");
  const site = "http://127.0.0.1:3421";
  const keys = ["1", "2", "3"].map((c) => `rm_${c.repeat(40)}`);
  const ids = run("rateFixture:seed", { keyHashes: keys.map(sha) });
  const results = await Promise.all(Array.from({ length: 50 }, async (_, i) => {
    const response = await fetch(`${site}/api/v1/inbox`, { method: "POST", headers: { authorization: `Bearer ${keys[0]}`, "content-type": "application/json" }, body: JSON.stringify({ text: `attempt-${i}` }) });
    return { status: response.status, retryAfter: response.headers.get("retry-after") };
  }));
  const elapsedMs = Date.now() - ids.startedAt;
  const allowed = results.filter((r) => r.status === 201).length;
  const limited = results.filter((r) => r.status === 429).length;
  assert.ok(allowed >= 10 && allowed <= 10 + Math.ceil(elapsedMs / 500), "Concurrent writes exceeded token budget");
  assert.ok(limited > 0);
  assert.equal(allowed + limited, 50);
  assert.ok(results.filter((r) => r.status === 429).every((r) => Number(r.retryAfter) >= 1));
  assert.equal((await fetch(`${site}/api/v1/me`, { headers: { authorization: `Bearer ${keys[0]}` } })).status, 200);
  for (const key of keys.slice(1)) {
    const response = await fetch(`${site}/api/v1/inbox`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ text: "independent allowance" }) });
    assert.equal(response.status, 201);
  }
  const snapshot = run("rateFixture:snapshot");
  assert.equal(snapshot.inbox.length, allowed + 2);
  assert.equal(snapshot.inbox.filter((r) => r.orgId === ids.orgB).length, 1);
  assert.equal(snapshot.inbox.filter((r) => r.orgId === ids.orgA).length, allowed + 1);
  assert.equal(snapshot.events, 0);
  assert.equal(configHash(), liveEnvHash);
  const summary = { level: "SERVICE: local Convex backend; synthetic records only", command: "node ops/rehearsal/rate-limit.mjs", requests: 50, allowed, limited, elapsedMs, oracle: "10 remaining tokens plus 1 refill per 500ms", sameOrgOtherKeyUnaffected: true, readsUnaffected: true, bUnaffected: true, inboxWrites: snapshot.inbox.length, rootDeploymentConfigUnchanged: true, fixtureSha256: sha(readFileSync(join(root, "ops/rehearsal/rate-fixture.ts"))), scratch, backendFiles: readdirSync(join(scratch, ".convex")), result: "PASS" };
  writeFileSync(join(root, "evidence/2026-09-24-unified-build/rate-limit-component-service.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
} finally {
  writeFileSync(join(scratch, "backend.log"), logs);
  try { process.kill(-backend.pid, "SIGTERM"); } catch { /* Process may have exited already. */ }
}
