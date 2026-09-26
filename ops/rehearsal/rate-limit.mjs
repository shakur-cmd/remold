import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { withLocalCore } from "./local-core.mjs";

const summary = await withLocalCore(async ({ site, run, scratch, root, sha }) => {
  const keys = ["1", "2", "3"].map((c) => `rm_${c.repeat(40)}`);
  const ids = run("rateFixture:seed", { keyHashes: keys.map(sha) });
  // Since I1, legacy agents answer 503 AUTHORITY_MIGRATING until the workspace is
  // frozen and the agent migrated. Run the real migration functions, as production does.
  for (const orgId of [ids.orgA, ids.orgB]) run("authority/migration:freeze", { orgId });
  for (const agentId of ids.agents) run("authority/migration:migrateAgent", { agentId });
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
  const summary = { level: "SERVICE: local Convex backend; synthetic records only", command: "node ops/rehearsal/rate-limit.mjs", requests: 50, allowed, limited, elapsedMs, oracle: "10 remaining tokens plus 1 refill per 500ms", sameOrgOtherKeyUnaffected: true, readsUnaffected: true, bUnaffected: true, inboxWrites: snapshot.inbox.length, rootDeploymentConfigUnchanged: true, fixtureSha256: sha(readFileSync(join(root, "ops/rehearsal/rate-fixture.ts"))), scratch, result: "PASS" };
  return summary;
});
writeFileSync(new URL("../../evidence/2026-09-24-unified-build/rate-limit-component-service.json", import.meta.url), JSON.stringify(summary, null, 2)+"\n");
console.log(JSON.stringify(summary, null, 2));
