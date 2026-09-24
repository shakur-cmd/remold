import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { withLocalCore } from "./local-core.mjs";

const summary = await withLocalCore(async ({ url, run, sha }) => {
  const ids = run("rateFixture:seed", { keyHashes: ["4", "5", "6"].map((c) => sha(`rm_${c.repeat(40)}`)) });
  const identityA = { tokenIdentifier: "proof-only", subject: "A" };
  const identityB = { tokenIdentifier: "proof-b", subject: "B" };
  const getA = () => run("orgs:get", { orgId: ids.orgA }, identityA);
  const getB = () => run("orgs:get", { orgId: ids.orgB }, identityB);
  const beforeA = getA(), beforeB = getB();
  assert.equal(beforeA.flags?.campaigns ?? false, false);
  const args = { orgId: ids.orgA, flag: "campaigns", enabled: true, reason: "service-rehearsal" };
  const response = await fetch(`${url}/api/mutation`, { method: "POST", signal: AbortSignal.timeout(10_000), headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "ops:setFlag", args, format: "json" }) });
  const refusal = await response.json();
  assert.equal(refusal.status, "error");
  assert.match(refusal.errorMessage, /public function/);
  assert.deepEqual(getA(), beforeA);
  assert.equal(run("rateFixture:snapshot").opsEvents.length, 0);
  run("ops:setFlag", args);
  run("ops:setFlag", args);
  assert.equal(getA().flags.campaigns, true);
  assert.deepEqual(getB(), beforeB);
  run("ops:setFlag", { ...args, enabled: false, reason: "service-rollback" });
  assert.equal(getA().flags.campaigns, false);
  const events = run("rateFixture:snapshot").opsEvents;
  assert.deepEqual(events.map((e) => [e.orgId, e.before, e.after, e.actor]), [
    [ids.orgA, false, true, { kind: "operator", id: "internal-admin" }],
    [ids.orgA, true, false, { kind: "operator", id: "internal-admin" }],
  ]);
  return { result: "PASS", level: "SERVICE local Convex; SIM impersonated identities", publicSetterRefused: true, flagEnableAndDisable: true, retryIdempotent: true, bUnchanged: true, auditEvents: 2, limitation: "Timed browser subscription / production AuthKit not tested" };
});
writeFileSync(new URL("../../evidence/2026-09-24-unified-build/flags-service.json", import.meta.url), JSON.stringify(summary, null, 2)+"\n");
console.log(JSON.stringify(summary, null, 2));
