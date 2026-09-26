// Round-2 independent adversarial run against 89bf0a5. Drives the builder's UNCHANGED executor.mjs,
// the proof-owned settle.ts, and the frozen H0 contract. Stresses the four fixes: atomic apply, metered
// usage floor, revocation kill, and replay/double-apply. Stub only, no inference, no spend.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { ConvexHttpClient } from 'convex/browser';
import { api } from './convex/_generated/api.js';
import { createExecutor, docker } from './executor.mjs';

const url = readFileSync('.env.local', 'utf8').match(/^CONVEX_URL=(.+)$/m)?.[1];
if (url !== 'http://127.0.0.1:3970') throw new Error('attack refuses unexpected target ' + url);
const client = new ConvexHttpClient(url, { logger: false });
const call = (name, args) => client.mutation(name === 'settle' ? api.settle.settle : api.harness[name], args);
const read = (name, args) => client.query(api.harness[name], args);
const cli = (name, args) => JSON.parse(execFileSync(process.execPath, ['../../../node_modules/convex/bin/main.js', 'run', 'harness:' + name, JSON.stringify(args)], { encoding: 'utf8' }));
const wait = ms => new Promise(r => setTimeout(r, ms));

const runId = 'r2' + randomUUID().slice(0, 6);
const results = [];
const imageHash = createHash('sha256').update(readFileSync('hostile/Dockerfile')).update(readFileSync('hostile/model.mjs')).digest('hex').slice(0, 12);
const image = 'remold-p6-hostile:' + imageHash;
const volumes = { A: `${runId}-A`, B: `${runId}-B` };

const seed = () => cli('seed', { run: randomUUID(), tokens: Array.from({ length: 10 }, () => randomUUID()) });
const dump = f => cli('dump', { orgs: [f.A.org, f.B.org] });
const org = (f, t) => dump(f).orgs.find(o => o._id === f[t].org);
const outputs = f => dump(f).records.filter(r => r.object === 'modelOutput');
const payload = account => ({ content: 'stub', audience: [], audienceVersion: 1, destination: account, schedule: 0, amountMinor: 0, currency: 'USD', workflowVersion: 1 });
async function fixture(policy = { maxUnitsPerRun: 8, maxDurationMs: 5000 }) {
  const f = seed();
  for (const t of ['A', 'B']) f[t].modelGrant = await call('grant', { token: f[t].sessions.owner, target: f[t].actors.manager, capability: 'model.call', scope: { kind: 'model', maxUnitsPerRun: 8, maxSteps: 1 }, mode: 'direct', delegate: false, expires: Date.now() + 600000 });
  const tenant = t => ({ agent: f[t].sessions.manager, adapter: f[t].adapter, volume: volumes[t], policy: typeof policy === 'function' ? policy(t) : policy });
  return { f, ex: createExecutor({ call, read, image, runId, tenants: { A: tenant('A'), B: tenant('B') } }) };
}
const modelOp = (f, t, units) => call('propose', { token: f[t].sessions.manager, logical: randomUUID(), binding: f[t].binding, capability: 'model.call', payload: payload(f[t].key.account), reservationUnits: units, maxSteps: 1 });

async function test(name, fn) {
  const started = Date.now();
  try { const evidence = await fn(); results.push({ name, status: 'PASS', ms: Date.now() - started, evidence }); console.log('PASS', name); }
  catch (e) { results.push({ name, status: 'FAIL', ms: Date.now() - started, error: String(e?.message ?? e) }); console.log('FAIL', name, '-', e?.message ?? e); }
}
const cleanup = () => {
  for (const id of docker('ps', '-aq', '--filter', 'label=remold-p6=' + runId).split('\n').filter(Boolean)) try { docker('rm', '-f', id); } catch {}
  for (const name of Object.values(volumes)) { try { docker('rm', '-f', name); } catch {} try { docker('volume', 'rm', '-f', name); } catch {} }
};

async function main() {
  docker('build', '-q', '-t', image, 'hostile');
  for (const [t, volume] of Object.entries(volumes)) {
    docker('volume', 'create', '--label', 'remold-p6=' + runId, volume);
    docker('run', '--rm', '--network', 'none', '--mount', `type=volume,src=${volume},dst=/work`, '--entrypoint', 'sh', 'node:22-alpine', '-c', `echo SECRET-${t}-${runId} > /work/tenant-secret-${t}.txt && chown -R 65534:65534 /work`);
  }

  await test('org kill in the apply window never applies output: 50 trials, varied timing', async () => {
    const bad = [];
    for (let i = 0; i < 50; i++) {
      const { f, ex } = await fixture();
      const id = await modelOp(f, 'A', 4);
      const jitter = i % 5; // 0..4 ms between setting readonly and the settle transaction
      const rec = await ex.run('A', { id, units: 4, intervalMs: 5, hooks: {
        beforeReconcile: async () => { await call('control', { token: f.A.sessions.owner, readonly: true }); if (jitter) await wait(jitter); },
      } });
      const o = org(f, 'A'), n = outputs(f).length;
      // Invariant: readonly set before the apply must block the apply; spend still books the meter.
      if (rec.applied || n !== 0 || o.spent !== 4) bad.push({ i, applied: rec.applied, outputs: n, spent: o.spent, late: rec.late });
    }
    assert.deepEqual(bad, [], `org-kill leaks: ${JSON.stringify(bad).slice(0, 800)}`);
    return { trials: 50, leaks: 0 };
  });

  await test('readonly fired concurrently (racing the settle txn) never yields a phantom or double output', async () => {
    // Fire control(readonly) WITHOUT awaiting, right as the guest finishes, so it races settle's own
    // transaction. Whatever wins, the number of applied outputs must equal the number of modelOutput
    // records, spend must equal the meter exactly once, and there must never be two records for one op.
    const summary = [];
    for (let i = 0; i < 40; i++) {
      const { f, ex } = await fixture();
      const id = await modelOp(f, 'A', 4);
      const rec = await ex.run('A', { id, units: 4, intervalMs: 5, hooks: {
        onToken: box => { if (box.tokens === 3) call('control', { token: f.A.sessions.owner, readonly: true }).catch(() => {}); },
      } });
      const o = org(f, 'A'), recs = outputs(f);
      assert.equal(recs.length, rec.applied ? 1 : 0, `record/apply mismatch i=${i}: applied=${rec.applied} records=${recs.length}`);
      assert.equal(o.spent, 4, `spend not exactly metered i=${i}: ${o.spent}`);
      summary.push(rec.applied ? 'applied' : 'blocked');
    }
    return { applied: summary.filter(x => x === 'applied').length, blocked: summary.filter(x => x === 'blocked').length, of: 40 };
  });

  await test('duplicate and concurrent settle for one op apply at most once and bill once', async () => {
    const { f, ex } = await fixture();
    const id = await modelOp(f, 'A', 4);
    const rec = await ex.run('A', { id, units: 4, intervalMs: 5 });
    assert.equal(rec.applied, true, JSON.stringify(rec));
    // Blast 6 concurrent replays with the same fence/step/providerRef and a different output payload.
    const replays = await Promise.allSettled(Array.from({ length: 6 }, () => call('settle', { token: f.A.adapter, id, fence: rec.fence, step: rec.step, providerRef: rec.providerRef, meter: 4, reported: 4, killed: false, output: 'DOUBLE' })));
    const recs = outputs(f), o = org(f, 'A');
    assert.deepEqual(recs.map(r => r.public), ['STUB_OK'], `double apply: ${JSON.stringify(recs.map(r => r.public))}`);
    assert.equal(o.spent, 4, `double bill: ${o.spent}`);
    return { firstApplied: true, replays: replays.map(r => r.status === 'fulfilled' ? r.value.applied : 'reject'), outputs: recs.length, spent: o.spent };
  });

  await test('replay with a different providerRef is a collision, not a second apply or bill', async () => {
    const { f, ex } = await fixture();
    const id = await modelOp(f, 'A', 4);
    const rec = await ex.run('A', { id, units: 4, intervalMs: 5 });
    const collide = await call('settle', { token: f.A.adapter, id, fence: rec.fence, step: rec.step, providerRef: 'FORGED', meter: 4, reported: 4, killed: false, output: 'COLLIDE' }).then(r => r, e => ({ error: e.message }));
    const recs = outputs(f), o = org(f, 'A');
    assert.deepEqual(recs.map(r => r.public), ['STUB_OK']);
    assert.equal(o.spent, 4);
    assert.equal(o.anomaly, 'provider result collision', `expected collision anomaly, got ${o.anomaly}`);
    return { collide, outputs: recs.length, spent: o.spent, anomaly: o.anomaly };
  });

  await test('usage floor: under-report billed at meter and not applied; over-report bills reported, overruns, not applied; honest applies', async () => {
    const under = await (async () => { const { f, ex } = await fixture(); const r = await ex.run('A', { id: await modelOp(f, 'A', 4), mode: 'underreport', units: 4, intervalMs: 5 }); const o = org(f, 'A'); return { billed: o.spent, applied: r.applied, anomaly: o.anomaly, usage: r.usage }; })();
    const over = await (async () => { const { f, ex } = await fixture(); const r = await ex.run('A', { id: await modelOp(f, 'A', 4), mode: 'overreport', units: 4, intervalMs: 5 }); const o = org(f, 'A'); return { billed: o.spent, applied: r.applied, overrun: r.overrun, anomaly: o.anomaly, usage: r.usage }; })();
    const honest = await (async () => { const { f, ex } = await fixture(); const r = await ex.run('A', { id: await modelOp(f, 'A', 4), units: 4, intervalMs: 5 }); return { applied: r.applied, usage: r.usage, outputs: outputs(f).length }; })();
    assert.equal(under.billed, 4); assert.equal(under.applied, false); assert.equal(under.anomaly, 'usageUnderreport'); assert.equal(under.usage, 4);
    assert.equal(over.applied, false); assert.equal(over.overrun, true); assert.equal(over.billed, 999); assert.equal(over.anomaly, 'usageOverrun');
    assert.equal(honest.applied, true); assert.equal(honest.usage, 4); assert.equal(honest.outputs, 1);
    return { under, over, honest };
  });

  await test('missing usage still holds the tenant even though settle now floors usage at the meter', async () => {
    const { f, ex } = await fixture();
    const r = await ex.run('A', { id: await modelOp(f, 'A', 2), mode: 'noUsage', units: 2, intervalMs: 5 });
    assert.equal(r.usage, undefined, JSON.stringify(r));
    assert.equal(r.applied, false);
    assert.equal(org(f, 'A').missingUsage, true);
    const next = await ex.run('A', { id: await modelOp(f, 'A', 1), units: 1, intervalMs: 5 });
    assert.match(next.refused ?? '', /usage unresolved/);
    return { missing: r, next };
  });

  await test('revocation mid-run kills within the bound and applies nothing, across 6 trials', async () => {
    const lat = [];
    for (let i = 0; i < 6; i++) {
      const { f, ex } = await fixture();
      const id = await modelOp(f, 'A', 8);
      let revokedAt;
      const onToken = box => { if (box.tokens === 2 && !revokedAt) { revokedAt = -1; call('revokeGrant', { token: f.A.sessions.owner, id: f.A.modelGrant }).then(() => { revokedAt = Date.now(); }); } };
      const r = await ex.run('A', { id, units: 8, intervalMs: 120, hooks: { onToken } });
      assert.equal(r.killed, 'cancel', JSON.stringify(r));
      const l = r.exitAt - revokedAt;
      assert(l <= 1500, `revocation kill latency ${l}`);
      assert(!r.applied && r.tokens < 8, JSON.stringify(r));
      assert.equal(outputs(f).length, 0);
      assert.equal(org(f, 'A').spent, r.tokens);
      lat.push(l);
    }
    return { latenciesMs: lat };
  });

  await test('global kill via disable() before the apply is sent applies nothing and waits for in-flight', async () => {
    const { f, ex } = await fixture();
    const id = await modelOp(f, 'A', 4);
    const r = await ex.run('A', { id, units: 4, intervalMs: 5, hooks: { beforeReconcile: () => ex.disable() } });
    assert.equal(r.applied, false, JSON.stringify(r));
    assert.equal(outputs(f).length, 0);
    assert.equal(org(f, 'A').spent, 4, 'usage still billed');
    return { r };
  });
}

let code = 1;
try { await main(); code = results.every(r => r.status === 'PASS') ? 0 : 1; }
catch (e) { console.error(e); }
finally {
  cleanup();
  writeFileSync('evidence/r2attack-results.json', JSON.stringify({ runId, image, at: new Date().toISOString(), target: '89bf0a5', results }, null, 2) + '\n');
  process.exit(code);
}
