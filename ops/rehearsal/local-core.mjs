import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, symlinkSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export async function withLocalCore(check, { cloudPort = 3420, sitePort = 3421 } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "remold-core-service-"));
  const sha = (s) => createHash("sha256").update(s).digest("hex");
  const configHash = () => existsSync(join(root, ".env.local")) ? sha(readFileSync(join(root, ".env.local"))) : null;
  const liveEnvHash = configHash();
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CONVEX_AGENT_MODE: "anonymous", CI: "1", CONVEX_DISABLE_METRICS: "1" };
  cpSync(join(root, "convex"), join(scratch, "convex"), { recursive: true, filter: (p) => !p.endsWith(".test.ts") && !p.endsWith("test.helpers.ts") && !p.endsWith("test.setup.ts") });
  cpSync(join(root, "ops/rehearsal/rate-fixture.ts"), join(scratch, "convex/rateFixture.ts"));
  writeFileSync(join(scratch, "convex/auth.config.ts"), "export default { providers: [] };\n");
  writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "remold-rate-proof", private: true, type: "module", dependencies: { convex: "1.46.0", "@convex-dev/rate-limiter": "0.4.0" } }));
  symlinkSync(join(root, "node_modules"), join(scratch, "node_modules"), "dir");
  const cli = join(root, "node_modules/convex/bin/main.js");
  let logs = "";
  const backend = spawn(process.execPath, [cli, "dev", "--typecheck", "disable", "--tail-logs", "disable", "--local-cloud-port", String(cloudPort), "--local-site-port", String(sitePort)], { cwd: scratch, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  backend.stdout.on("data", (b) => { logs += b; });
  backend.stderr.on("data", (b) => { logs += b; });
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const run = (fn, args = {}, identity) => {
    const output = execFileSync(process.execPath, [cli, "run", fn, JSON.stringify(args), ...(identity ? ["--identity", JSON.stringify(identity)] : [])], { cwd: scratch, env, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
    return output.trim() ? JSON.parse(output) : null;
  };
  try {
    const deadline = Date.now() + 180_000;
    while (!/Convex functions ready/.test(logs)) {
      if (backend.exitCode !== null || Date.now() > deadline) throw new Error(`Local backend failed to become ready. Log retained at ${scratch}/backend.log`);
      await pause(250);
    }
    const config = readFileSync(join(scratch, ".env.local"), "utf8");
    const url = /^(?:VITE_)?CONVEX_URL=(.+)$/m.exec(config)?.[1];
    assert.ok(url && ["127.0.0.1", "localhost"].includes(new URL(url).hostname), "Refusing non-loopback proof deployment");
    const result = await check({ site: `http://127.0.0.1:${sitePort}`, url, run, scratch, root, sha });
    assert.equal(configHash(), liveEnvHash, "Root deployment config changed");
    return { ...result, rootDeploymentConfigUnchanged: true, scratch };
  } finally {
    writeFileSync(join(scratch, "backend.log"), logs);
    try { process.kill(-backend.pid, "SIGTERM"); } catch { /* Process may have exited already. */ }
  }
}
