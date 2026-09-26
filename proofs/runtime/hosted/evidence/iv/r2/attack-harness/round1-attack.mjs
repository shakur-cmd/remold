// Independent adversarial run: drives the builder's UNCHANGED executor.mjs and H0 contract, but with a
// hostile guest image and forged/oversized/late protocol messages. Confirms the boundary holds and the
// control plane never applies output the executor should have rejected. Stub only, no inference, no spend.
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

const runId = 'atk' + randomUUID().slice(0, 6);
const results = [];
const imageHash = createHash('sha256').update(readFileSync('hostile/Dockerfile')).update(readFileSync('hostile/model.mjs')).digest('hex').slice(0, 12);
const image = 'remold-p6-hostile:' + imageHash;
const volumes = { A: `${runId}-A`, B: `${runId}-B` };

const seed = () => cli('seed', { run: randomUUID(), tokens: Array.from({ length: 10 }, () => randomUUID()) });
const dump = f => cli('dump', { orgs: [f.A.org, f.B.org] });
const org = (f, t) => dump(f).orgs.find(o => o._id === f[t].org);
const payload = account => ({ content: 'stub', audience: [], audienceVersion: 1, destination: account, schedule: 0, amountMinor: 0, currency: 'USD', workflowVersion: 1 });
async function fixture(policy = { maxUnitsPerRun: 8, maxDurationMs: 5000 }) {
  const f = seed();
  for (const t of ['A', 'B']) await call('grant', { token: f[t].sessions.owner, target: f[t].actors.manager, capability: 'model.call', scope: { kind: 'model', maxUnitsPerRun: 8, maxSteps: 1 }, mode: 'direct', delegate: false, expires: Date.now() + 600000 });
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
  for (const name of [...Object.values(volumes), `${runId}-canary`]) { try { docker('rm', '-f', name); } catch {} try { docker('volume', 'rm', '-f', name); } catch {} }
};

async function main() {
  docker('build', '-q', '-t', image, 'hostile');
  for (const [t, volume] of Object.entries(volumes)) {
    docker('volume', 'create', '--label', 'remold-p6=' + runId, volume);
    docker('run', '--rm', '--network', 'none', '--mount', `type=volume,src=${volume},dst=/work`, '--entrypoint', 'sh', 'node:22-alpine', '-c', `echo SECRET-${t}-${runId} > /work/tenant-secret-${t}.txt && chown -R 65534:65534 /work`);
  }

  await test('hostile guest cannot escape sandbox, cross-read the other tenant, or reach the host/control plane', async () => {
    const canary = `${runId}-canary`;
    docker('run', '-d', '--rm', '--name', canary, '--label', 'remold-p6=' + runId, '--network', 'bridge', '--entrypoint', 'node', 'node:22-alpine', '-e', `require('http').createServer((q,s)=>s.end('CANARY')).listen(8080)`);
    const canaryIp = docker('inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', canary);
    const gateway = docker('network', 'inspect', '-f', '{{(index .IPAM.Config 0).Gateway}}', 'bridge');
    await wait(500);
    const targets = [{ host: canaryIp, port: 8080 }, { host: gateway, port: 3940 }, { host: '1.1.1.1', port: 443 }];
    const { f, ex } = await fixture();
    const probes = {};
    for (const t of ['A', 'B']) {
      const id = await modelOp(f, t, 1);
      const rec = await ex.run(t, { id, mode: 'hostile', units: 1, targets });
      assert.equal(rec.applied, true, `${t} probe applied: ${JSON.stringify(rec)}`);
      probes[t] = JSON.parse(ex.effects.find(e => e.id === id).output);
    }
    for (const [t, other] of [['A', 'B'], ['B', 'A']]) {
      const p = probes[t];
      assert.deepEqual(p.secretsFound.map(s => s.text), [`SECRET-${t}-${runId}`], `${t} secretsFound ${JSON.stringify(p.secretsFound)}`);
      assert(!JSON.stringify(p).includes(`SECRET-${other}-`), `${t} leaked ${other}`);
      assert.deepEqual(p.hostPaths, [], `${t} hostPaths ${JSON.stringify(p.hostPaths)}`);
      assert.equal(p.uid, 65534, `${t} uid`);
      assert.deepEqual(p.interfaces, ['lo'], `${t} interfaces ${JSON.stringify(p.interfaces)}`);
      assert.deepEqual(p.envLeak, [], `${t} envLeak ${JSON.stringify(p.envLeak)}`);
      assert.equal(p.writes.rootEtc.startsWith('ERR'), true, `${t} wrote /etc: ${p.writes.rootEtc}`);
      assert.equal(p.writes.varTmp.startsWith('ERR'), true, `${t} wrote /var/tmp: ${p.writes.varTmp}`);
      assert.equal(p.writes.proc.startsWith('ERR'), true, `${t} wrote sysrq: ${p.writes.proc}`);
      for (const [k, v] of Object.entries(p.net)) assert.notEqual(v, 'CONNECTED', `${t} reached ${k} -> ${v}`);
      // /work is the tenant's own volume, so a write there is expected and fine.
      assert.equal(p.writes.work, 'WROTE', `${t} own workspace writable`);
    }
    return { probes };
  });

  await test('forged tenant ids on stdout never cross-bill another tenant', async () => {
    const { f, ex } = await fixture({ maxUnitsPerRun: 8, maxDurationMs: 4000 });
    const id = await modelOp(f, 'B', 4);
    const rec = await ex.run('B', { id, mode: 'forge', units: 4, intervalMs: 20 });
    // Guest streamed tenant:'A-FORGED'. The executor keys everything off the trusted call() session, so
    // tenant A must be untouched regardless of what B's guest claims on stdout.
    const a = org(f, 'A'), b = org(f, 'B');
    assert.equal(a.spent, 0, 'tenant A untouched by forged ids');
    assert.equal(a.reserved, 0, 'tenant A no reservation from B');
    return { rec: { tokens: rec.tokens, usage: rec.usage, applied: rec.applied, overrun: rec.overrun }, aSpent: a.spent, bSpent: b.spent };
  });

  await test('DEFECT PROBE: guest-controlled usage report is billed verbatim for finished runs (under- and over-reporting)', async () => {
    // executor.mjs:107 -> `usage = box.killed ? box.tokens : box.done?.usage`. For a finished (unkilled) run
    // the guest's self-reported number is trusted over the executor's own token meter (box.tokens).
    // Under-report: consume real compute, bill less. Over-report: inflate spend past the cap.
    const under = await (async () => {
      const { f, ex } = await fixture({ maxUnitsPerRun: 8, maxDurationMs: 4000 });
      const id = await modelOp(f, 'A', 4);
      const rec = await ex.run('A', { id, mode: 'underreport', units: 4, intervalMs: 10 });
      return { tokensStreamed: rec.tokens, usageBilled: rec.usage, orgSpent: org(f, 'A').spent, applied: rec.applied };
    })();
    const over = await (async () => {
      const { f, ex } = await fixture({ maxUnitsPerRun: 8, maxDurationMs: 4000 });
      const id = await modelOp(f, 'A', 4);
      const rec = await ex.run('A', { id, mode: 'overreport', units: 4, intervalMs: 10 });
      const o = org(f, 'A');
      return { tokensStreamed: rec.tokens, usageBilled: rec.usage, orgSpent: o.spent, orgCap: o.cap, overrun: rec.overrun, anomaly: o.anomaly, applied: rec.applied };
    })();
    // This test PASSES when it demonstrates the gap (so it is recorded, not silently green). The finding is
    // that the executor does not clamp usage to its own meter; report it, do not certify usage as tamper-proof.
    assert(under.usageBilled < under.tokensStreamed, `under-report expected billed<streamed, got ${JSON.stringify(under)}`);
    assert(over.orgSpent > over.orgCap, `over-report expected spend past cap, got ${JSON.stringify(over)}`);
    return { under, over, note: 'executor trusts done.usage for finished runs; independent meter box.tokens is ignored except on kill' };
  });

  await test('oversized output does not crash the executor; the next run still works', async () => {
    const { f, ex } = await fixture({ maxUnitsPerRun: 8, maxDurationMs: 4000 });
    const id = await modelOp(f, 'A', 4);
    const rec = await ex.run('A', { id, mode: 'oversize', units: 4, intervalMs: 10 });
    const a = org(f, 'A');
    // The point here is resilience, not accounting: a 25MB stdout burst must not crash the trusted executor.
    const ctl = await ex.run('B', { id: await modelOp(f, 'B', 1), units: 1, intervalMs: 10 });
    assert.equal(ctl.applied, true, 'control still runs after oversized output');
    assert(a.spent <= 4, `A billed within reservation ${a.spent}`);
    return { rec: { tokens: rec.tokens, usage: rec.usage, killed: rec.killed, applied: rec.applied }, aSpent: a.spent, aReserved: a.reserved };
  });

  await test('DEFECT PROBE: widened org-kill race applies output after the org is killed', async () => {
    // Builder disclosed: the org kill (readonly) is not treated as late at reconcile. Widen the window
    // deterministically by setting readonly AFTER the executor final status check but BEFORE reconcile,
    // repeated, and show whether output lands. A PASS here means the gap is real and reproduced.
    const applied = [], spentAfterKill = [];
    for (let i = 0; i < 8; i++) {
      const { f, ex } = await fixture({ maxUnitsPerRun: 8, maxDurationMs: 4000 });
      const id = await modelOp(f, 'A', 4);
      const rec = await ex.run('A', { id, units: 4, intervalMs: 10, hooks: {
        beforeReconcile: async () => { await call('control', { token: f.A.sessions.owner, readonly: true }); await wait(5); },
      } });
      if (rec.applied) applied.push({ i, tokens: rec.tokens, late: rec.late, cancelledBeforeReconcile: rec.cancelledBeforeReconcile });
      spentAfterKill.push(org(f, 'A').spent);
    }
    assert(applied.length > 0, 'expected the race to apply output at least once');
    return { appliedCount: applied.length, of: 8, applied, spentAfterKill, finding: 'org kill in the reconcile window does not stop output application' };
  });

  await test('a finished run using less than its reservation returns reserved to zero (no leak)', async () => {
    // Control for the accounting path: usage(1) < reservation(4) must still free the reservation.
    const { f, ex } = await fixture({ maxUnitsPerRun: 8, maxDurationMs: 4000 });
    const id = await modelOp(f, 'A', 4);
    const rec = await ex.run('A', { id, mode: 'underreport', units: 4, intervalMs: 10 });
    const o = org(f, 'A');
    assert.equal(o.reserved, 0, `reservation leaked: ${JSON.stringify({ billed: o.spent, reserved: o.reserved })}`);
    return { reservation: 4, billed: o.spent, reservedAfter: o.reserved, applied: rec.applied };
  });

  await test('late result after cancel is billed but never applied even with a rushed reconcile', async () => {
    const { f, ex } = await fixture({ maxUnitsPerRun: 8, maxDurationMs: 4000 });
    const id = await modelOp(f, 'A', 4);
    const rec = await ex.run('A', { id, units: 4, intervalMs: 10, hooks: {
      beforeReconcile: () => call('cancel', { token: f.A.sessions.owner, id }),
    } });
    assert.equal(rec.applied, false, 'applied after cancel');
    assert.equal(rec.late, true, 'not marked late');
    assert(!ex.effects.some(e => e.id === id), 'output leaked');
    const o = org(f, 'A');
    assert.equal(o.spent, 4, 'late usage still billed');
    return { rec, oSpent: o.spent };
  });

  await test('concurrent higher-pressure load never exceeds org or global hard caps', async () => {
    const { f, ex } = await fixture();
    const recs = await Promise.all(['A', 'B'].flatMap(t => Array.from({ length: 10 }, async () => {
      const id = await modelOp(f, t, 4);
      return ex.run(t, { id, units: 4, intervalMs: 60 });
    })));
    const d = dump(f), budget = d.budgets[0];
    for (const t of ['A', 'B']) {
      const o = d.orgs.find(x => x._id === f[t].org);
      assert(o.spent + o.reserved <= o.cap, `${t} ${o.spent}+${o.reserved} over cap ${o.cap}`);
      assert.equal(o.reserved, 0, `${t} leaked reservation`);
    }
    assert(budget.spent + budget.reserved <= budget.cap, `global over cap`);
    assert(ex.peaks.A <= 1 && ex.peaks.B <= 1 && ex.peaks.global <= budget.maxConcurrent, `peaks ${JSON.stringify(ex.peaks)}`);
    const refused = recs.filter(r => r.refused).length;
    return { orgs: d.orgs.map(o => ({ cap: o.cap, spent: o.spent, reserved: o.reserved })), global: { cap: budget.cap, spent: budget.spent, reserved: budget.reserved, maxConcurrent: budget.maxConcurrent }, peaks: ex.peaks, refused };
  });
}

let code = 1;
try { await main(); code = results.every(r => r.status === 'PASS') ? 0 : 1; }
catch (e) { console.error(e); }
finally {
  cleanup();
  writeFileSync('evidence/attack-results.json', JSON.stringify({ runId, image, at: new Date().toISOString(), results }, null, 2) + '\n');
  process.exit(code);
}
