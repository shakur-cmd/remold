// P6 deterministic suite: hosted executor isolation, hard caps, kill switch, late results, missing usage.
// Runs against the verbatim H0 contract on a local anonymous Convex backend. Stub model only.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { ConvexHttpClient } from 'convex/browser';
import { api } from './convex/_generated/api.js';
import { createExecutor, docker, WATCH_INTERVAL_MS } from './executor.mjs';

const url = readFileSync('.env.local', 'utf8').match(/^CONVEX_URL=(.+)$/m)?.[1];
if (url !== 'http://127.0.0.1:3810') throw new Error('Proof refuses unexpected target');
const client = new ConvexHttpClient(url, { logger: false });
const call = (name, args) => client.mutation(api.harness[name], args);
const read = (name, args) => client.query(api.harness[name], args);
const cli = (name, args) => JSON.parse(execFileSync(process.execPath, ['../../../node_modules/convex/bin/main.js', 'run', 'harness:' + name, JSON.stringify(args)], { encoding: 'utf8' }));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Stated bound: kill trigger to sandbox exit. Watch interval plus one status read plus docker kill.
const KILL_BOUND_MS = 1500;
const runId = randomUUID().slice(0, 8);
const only = process.env.P6_ONLY?.split(',');
const results = [];
const imageHash = createHash('sha256').update(readFileSync('stub/Dockerfile')).update(readFileSync('stub/model.mjs')).digest('hex').slice(0, 12);
const image = 'remold-p6-stub:' + imageHash;
const volumes = { A: `remold-p6-${runId}-A`, B: `remold-p6-${runId}-B` };

async function test(name, fn) {
  if (only && !only.includes(name)) return;
  const started = Date.now();
  try {
    const evidence = await fn();
    results.push({ name, status: 'PASS', ms: Date.now() - started, evidence });
    console.log('PASS', name);
  } catch (error) {
    results.push({ name, status: 'FAIL', ms: Date.now() - started, error: String(error?.message ?? error) });
    console.log('FAIL', name, '-', error?.message ?? error);
  }
}

const seed = () => cli('seed', { run: randomUUID(), tokens: Array.from({ length: 10 }, () => randomUUID()) });
const dump = f => cli('dump', { orgs: [f.A.org, f.B.org] });
const org = (f, t) => dump(f).orgs.find(o => o._id === f[t].org);
const payload = account => ({ content: 'stub model task', audience: [], audienceVersion: 1, destination: account, schedule: 0, amountMinor: 0, currency: 'USD', workflowVersion: 1 });
async function grantModel(f, t) {
  await call('grant', { token: f[t].sessions.owner, target: f[t].actors.manager, capability: 'model.call', scope: { kind: 'model', maxUnitsPerRun: 8, maxSteps: 1 }, mode: 'direct', delegate: false, expires: Date.now() + 600000 });
}
const modelOp = (f, t, units) => call('propose', { token: f[t].sessions.manager, logical: randomUUID(), binding: f[t].binding, capability: 'model.call', payload: payload(f[t].key.account), reservationUnits: units, maxSteps: 1 });
async function fixture(policy = { maxUnitsPerRun: 8, maxDurationMs: 5000 }) {
  const f = seed();
  await grantModel(f, 'A');
  await grantModel(f, 'B');
  const tenant = t => ({ agent: f[t].sessions.manager, adapter: f[t].adapter, volume: volumes[t], policy: typeof policy === 'function' ? policy(t) : policy });
  return { f, ex: createExecutor({ call, read, image, runId, tenants: { A: tenant('A'), B: tenant('B') } }) };
}
const cleanup = () => {
  for (const id of docker('ps', '-aq', '--filter', 'label=remold-p6=' + runId).split('\n').filter(Boolean)) try { docker('rm', '-f', id); } catch { }
  for (const name of [...Object.values(volumes), `remold-p6-${runId}-canary`]) {
    try { docker('rm', '-f', name); } catch { }
    try { docker('volume', 'rm', '-f', name); } catch { }
  }
};

async function main() {
  docker('build', '-q', '-t', image, 'stub');
  for (const [t, volume] of Object.entries(volumes)) {
    docker('volume', 'create', '--label', 'remold-p6=' + runId, volume);
    docker('run', '--rm', '--network', 'none', '--mount', `type=volume,src=${volume},dst=/work`, '--entrypoint', 'sh', 'node:22-alpine', '-c', `echo SECRET-${t}-${runId} > /work/tenant-secret-${t}.txt && chown -R 65534:65534 /work`);
  }

  await test('isolation: each tenant sandbox sees only its own workspace, no network, no host paths or secrets', async () => {
    const canary = `remold-p6-${runId}-canary`;
    docker('run', '-d', '--rm', '--name', canary, '--label', 'remold-p6=' + runId, '--network', 'bridge', '--entrypoint', 'node', 'node:22-alpine', '-e', `require('http').createServer((q,s)=>s.end('SECRET-B-SERVICE')).listen(8080)`);
    const canaryIp = docker('inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', canary);
    const gateway = docker('network', 'inspect', '-f', '{{(index .IPAM.Config 0).Gateway}}', 'bridge');
    // Positive control: the canary is live from a normally networked container, so an unreachable result means something.
    await wait(500);
    const control = docker('run', '--rm', '--network', 'bridge', '--entrypoint', 'node', 'node:22-alpine', '-e', `fetch('http://${canaryIp}:8080').then(r=>r.text()).then(console.log,()=>console.log('DOWN'))`);
    assert.equal(control, 'SECRET-B-SERVICE', 'canary positive control');
    const targets = [{ host: canaryIp, port: 8080 }, { host: gateway, port: 22 }, { host: '1.1.1.1', port: 443 }, { host: '169.254.169.254', port: 80 }];
    const { f, ex } = await fixture();
    const probes = {};
    for (const t of ['A', 'B']) {
      const id = await modelOp(f, t, 1);
      const record = await ex.run(t, { id, mode: 'probe', units: 1, targets });
      assert.equal(record.applied, true, `${t} probe completed: ${JSON.stringify(record)}`);
      probes[t] = JSON.parse(ex.effects.find(e => e.id === id).output);
    }
    for (const [t, other] of [['A', 'B'], ['B', 'A']]) {
      const p = probes[t];
      assert.deepEqual(p.secrets, [{ path: `/work/tenant-secret-${t}.txt`, text: `SECRET-${t}-${runId}` }], `${t} sees only its own secret file`);
      assert(!JSON.stringify(p).includes(`SECRET-${other}-`), `${t} never sees ${other} data`);
      assert.deepEqual(p.reachable, [], `${t} reached ${JSON.stringify(p.reachable)}`);
      assert.deepEqual(p.interfaces, ['lo'], `${t} interfaces`);
      assert.deepEqual(p.env.filter(k => /TOKEN|KEY|SECRET|CONVEX|ANTHROPIC|OPENAI|CLAUDE|CODEX|REMOLD/i.test(k)), [], `${t} env ${p.env}`);
      assert.equal(p.uid, 65534);
      assert.equal(p.rootWritable, false);
      assert.deepEqual(p.hostPaths, [], `${t} host paths`);
    }
    return { targets, probes };
  });

  await test('missing cap means zero: no executor cap refuses before any reservation', async () => {
    const { f, ex } = await fixture(t => t === 'A' ? { maxDurationMs: 5000 } : { maxUnitsPerRun: 8, maxDurationMs: 5000 });
    const id = await modelOp(f, 'A', 1);
    const refused = await ex.run('A', { id, units: 1 });
    assert.equal(refused.refused, 'executor policy cap');
    assert.equal((await read('operation', { token: f.A.sessions.owner, id })).state, 'proposed');
    const a = org(f, 'A');
    assert.equal(a.reserved + a.spent, 0);
    const control = await ex.run('B', { id: await modelOp(f, 'B', 1), units: 1 });
    assert.equal(control.applied, true, 'positive control with an explicit cap');
    return { refused, control };
  });

  await test('concurrent reservations never exceed org or global hard caps', async () => {
    const { f, ex } = await fixture();
    const waves = [];
    for (let wave = 0; wave < 3; wave++) {
      const ids = { A: [], B: [] };
      for (const t of ['A', 'B']) for (let i = 0; i < 6; i++) ids[t].push(await modelOp(f, t, 4));
      const records = await Promise.all(['A', 'B'].flatMap(t => ids[t].map(id => ex.run(t, { id, units: 4, intervalMs: 150 }))));
      waves.push(records.map(r => ({ tenant: r.tenant, applied: r.applied, refused: r.refused, usage: r.usage })));
    }
    const d = dump(f), budget = d.budgets[0];
    for (const t of ['A', 'B']) {
      const o = d.orgs.find(x => x._id === f[t].org);
      assert(o.spent + o.reserved <= o.cap, `${t} spent ${o.spent} + reserved ${o.reserved} exceeds cap ${o.cap}`);
      assert.equal(o.reserved, 0, `${t} leaked reservation`);
      assert(ex.effects.some(e => e.tenant === t), `${t} positive control: some run completed`);
    }
    assert(budget.spent + budget.reserved <= budget.cap, `global ${budget.spent}+${budget.reserved} exceeds ${budget.cap}`);
    assert(ex.peaks.A <= 1 && ex.peaks.B <= 1 && ex.peaks.global <= budget.maxConcurrent, `peaks ${JSON.stringify(ex.peaks)}`);
    assert(waves.flat().some(r => r.refused), 'some runs refused');
    return { orgs: d.orgs.map(o => ({ cap: o.cap, spent: o.spent, reserved: o.reserved })), global: budget, peaks: ex.peaks, waves };
  });

  await test('org kill switch stops the running sandbox within the bound, refuses queued work, leaves the other tenant running', async () => {
    const { f, ex } = await fixture();
    const idA = await modelOp(f, 'A', 8), queued = await modelOp(f, 'A', 1), idB = await modelOp(f, 'B', 7);
    let killIssuedAt;
    const onToken = box => { if (box.tokens === 2 && !killIssuedAt) { killIssuedAt = -1; call('control', { token: f.A.sessions.owner, readonly: true }).then(() => { killIssuedAt = Date.now(); }); } };
    const [a, b] = await Promise.all([ex.run('A', { id: idA, units: 8, intervalMs: 150, hooks: { onToken } }), ex.run('B', { id: idB, units: 7, intervalMs: 100 })]);
    const latency = a.exitAt - killIssuedAt;
    assert.equal(a.killed, 'cancel', JSON.stringify(a));
    assert(latency <= KILL_BOUND_MS, `kill latency ${latency}ms`);
    assert(a.tokens < 8 && !a.applied, JSON.stringify(a));
    assert(b.applied && !b.killed, 'tenant B unaffected ' + JSON.stringify(b));
    const q = await ex.run('A', { id: queued, units: 1 });
    assert.match(q.refused ?? '', /readonly/);
    const o = org(f, 'A');
    assert.equal(o.spent, a.tokens, 'residual usage reconciled from the executor meter');
    assert.equal(o.reserved, 0);
    return { latencyMs: latency, boundMs: KILL_BOUND_MS, watchIntervalMs: WATCH_INTERVAL_MS, a, b, queued: q, orgA: { spent: o.spent, reserved: o.reserved } };
  });

  await test('cancel stops a running sandbox; a result reported after cancel is recorded as late and has no effect', async () => {
    const { f, ex } = await fixture();
    const id1 = await modelOp(f, 'A', 4);
    let cancelAt;
    const onToken = box => { if (box.tokens === 1 && !cancelAt) { cancelAt = -1; call('cancel', { token: f.A.sessions.owner, id: id1 }).then(() => { cancelAt = Date.now(); }); } };
    const running = await ex.run('A', { id: id1, units: 4, intervalMs: 250, hooks: { onToken } });
    assert.equal(running.killed, 'cancel');
    assert(running.exitAt - cancelAt <= KILL_BOUND_MS, `cancel latency ${running.exitAt - cancelAt}`);
    assert(!running.applied && running.late, JSON.stringify(running));
    const id2 = await modelOp(f, 'A', 4);
    const held = await ex.run('A', { id: id2, units: 4, intervalMs: 10, hooks: { beforeReconcile: () => call('cancel', { token: f.A.sessions.owner, id: id2 }) } });
    assert.equal(held.killed, undefined);
    assert.equal(held.usage, 4);
    assert.equal(held.late, true, JSON.stringify(held));
    assert.equal(held.cancelledBeforeReconcile, false, 'cancel landed after the final status check, so only the late flag can stop it');
    assert.equal(held.applied, false);
    assert(!ex.effects.some(e => e.id === id1 || e.id === id2), 'no output applied');
    const o = org(f, 'A');
    assert.equal(o.spent, running.tokens + 4, 'late usage is still billed');
    assert.equal(o.reserved, 0);
    const replay = await call('reconcile', { token: f.A.adapter, id: id2, fence: held.fence + 1, step: held.step, providerRef: 'replay', usage: 1 }).then(() => 'accepted', e => e.message);
    assert.match(replay, /stale\/unpermitted outcome/);
    return { cancelLatencyMs: running.exitAt - cancelAt, running, held, replay, orgA: { spent: o.spent, reserved: o.reserved } };
  });

  await test('a result reported after the org kill switch has no effect', async () => {
    const { f, ex } = await fixture();
    const id = await modelOp(f, 'A', 4);
    const held = await ex.run('A', { id, units: 4, intervalMs: 10, hooks: { beforeCheck: () => call('control', { token: f.A.sessions.owner, readonly: true }) } });
    assert.equal(held.killed, undefined);
    assert.equal(held.cancelledBeforeReconcile, true);
    assert.equal(held.applied, false, JSON.stringify(held));
    assert.equal(org(f, 'A').spent, 4, 'usage still recorded');
    return { held };
  });

  await test('global kill switch stops every running sandbox within the bound and refuses new runs', async () => {
    const { f, ex } = await fixture();
    const idA = await modelOp(f, 'A', 8), idB = await modelOp(f, 'B', 7), later = await modelOp(f, 'A', 1);
    let killAt;
    const onToken = box => { if (box.tokens === 2 && !killAt) { killAt = Date.now(); ex.disable(); } };
    const records = await Promise.all([ex.run('A', { id: idA, units: 8, intervalMs: 150, hooks: { onToken } }), ex.run('B', { id: idB, units: 7, intervalMs: 150 })]);
    for (const r of records) {
      assert.equal(r.killed, 'global', JSON.stringify(r));
      assert(r.exitAt - killAt <= KILL_BOUND_MS, `global kill latency ${r.exitAt - killAt}`);
      assert(!r.applied && r.tokens < r.units);
    }
    const refused = await ex.run('A', { id: later, units: 1 });
    assert.equal(refused.refused, 'hosted disabled');
    return { latenciesMs: records.map(r => r.exitAt - killAt), records, refused };
  });

  await test('missing usage report fails closed for that tenant only', async () => {
    const { f, ex } = await fixture();
    const missing = await ex.run('A', { id: await modelOp(f, 'A', 2), mode: 'noUsage', units: 2, intervalMs: 10 });
    assert.equal(missing.usage, undefined, JSON.stringify(missing));
    assert.equal(missing.applied, false);
    assert.equal(org(f, 'A').missingUsage, true);
    const next = await ex.run('A', { id: await modelOp(f, 'A', 1), units: 1, intervalMs: 10 });
    assert.match(next.refused ?? '', /usage unresolved/);
    const other = await ex.run('B', { id: await modelOp(f, 'B', 1), units: 1, intervalMs: 10 });
    assert.equal(other.applied, true, 'tenant B positive control');
    return { missing, next, other };
  });

  await test('token overshoot and duration limits stop the sandbox and fail visibly', async () => {
    const { f, ex } = await fixture({ maxUnitsPerRun: 8, maxDurationMs: 800 });
    const over = await ex.run('A', { id: await modelOp(f, 'A', 4), mode: 'overshoot', units: 4 });
    assert.equal(over.killed, 'tokens', JSON.stringify(over));
    assert(!over.applied && over.overrun && over.usage > 4);
    assert.equal(org(f, 'A').anomaly, 'usageOverrun');
    const blocked = await ex.run('A', { id: await modelOp(f, 'A', 1), units: 1 });
    assert.match(blocked.refused ?? '', /anomaly/);
    const hang = await ex.run('B', { id: await modelOp(f, 'B', 4), mode: 'hang', units: 4 });
    assert.equal(hang.killed, 'duration', JSON.stringify(hang));
    assert.equal(hang.applied, false);
    return { over, blocked, hang };
  });
}

let code = 1;
try {
  await main();
  code = results.length && results.every(r => r.status === 'PASS') ? 0 : 1;
} catch (error) {
  console.error(error);
} finally {
  cleanup();
  writeFileSync(process.env.P6_RESULTS ?? 'evidence/results.json', JSON.stringify({ runId, image, at: new Date().toISOString(), level: 'SERVICE control plane (local Convex, verbatim H0) / SIM model (stub) / local Docker sandbox', results }, null, 2) + '\n');
  writeFileSync('evidence/.run-result.json', JSON.stringify({ code }));
}
