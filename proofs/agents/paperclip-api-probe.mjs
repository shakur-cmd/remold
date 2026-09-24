import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

// Runs inside the disposable, network-isolated candidate container.
const base = 'http://localhost:3100';
const statePath = '/tmp/remold-proof-session.json';
let state = await readFile(statePath, 'utf8').then(JSON.parse).catch(() => ({}));
const results = [];
async function request(method, path, body, token) {
  const headers = { Origin: base, 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  else if (state.cookie) headers.Cookie = state.cookie;
  const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const cookies = response.headers.getSetCookie();
  if (cookies.length && !token) state.cookie = cookies.map(c => c.split(';')[0]).join('; ');
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = { nonJson: true }; }
  return { status: response.status, data };
}
async function ok(method, path, body, token) {
  const r = await request(method, path, body, token);
  assert.ok(r.status >= 200 && r.status < 300, `${method} ${path}: ${r.status} ${JSON.stringify(r.data).slice(0, 500)}`);
  return r.data;
}
async function save() { await writeFile(statePath, JSON.stringify(state), { mode: 0o600 }); }
try {
  const health = await ok('GET', '/api/health');
  assert.equal(health.commit, 'e006c18f2036d95d47ca8f7eb068670f3c54942d');
  assert.equal(health.deploymentMode, 'authenticated');
  results.push({ name: 'Pinned authenticated service responds', pass: true, commit: health.commit });
  if (!state.cookie) {
    await ok('POST', '/api/auth/sign-up/email', { name: 'Synthetic Remold verifier', email: `fixture-${Date.now()}@example.invalid`, password: randomBytes(24).toString('hex') });
    await save();
  }
  if (!state.bootstrapped) {
    const token = (await readFile('/tmp/remold-bootstrap.txt', 'utf8')).match(/pcp_bootstrap_[a-f0-9]+/)?.[0];
    assert.ok(token, 'Private bootstrap token exists');
    await ok('POST', `/api/invites/${token}/accept`, { requestType: 'human' });
    state.bootstrapped = true; await save();
  }
  for (const name of ['A', 'B']) {
    if (!state[name]) {
      state[name] = await ok('POST', '/api/companies', { name: `Synthetic Remold ${name}`, budgetMonthlyCents: 0 });
      await save();
    }
  }
  await mkdir('/tmp/remold-tenant-b', { recursive: true });
  await writeFile('/tmp/remold-tenant-b/sentinel.txt', 'synthetic-tenant-b-only');
  if (!state.agentA) {
    // Canary values reveal isolation failures without exposing real credentials.
    const code = `const fs=require('fs'); console.log(JSON.stringify({bFileReadable:fs.existsSync('/tmp/remold-tenant-b/sentinel.txt'),authSecretInherited:Boolean(process.env.BETTER_AUTH_SECRET),hostHomeMounted:fs.existsSync('/Users/urkel'),apiTokenPresent:Boolean(process.env.PAPERCLIP_API_KEY)}));`;
    state.agentA = await ok('POST', `/api/companies/${state.A.id}/agents`, { name: 'Synthetic executor A', role: 'ceo', adapterType: 'process', adapterConfig: { command: '/usr/local/bin/node', args: ['-e', code], cwd: '/tmp', timeoutSec: 15 }, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } }, permissions: { canCreateAgents: false }, budgetMonthlyCents: 0 });
    await save();
  }
  if (!state.keyA) { state.keyA = await ok('POST', `/api/agents/${state.agentA.id}/keys`, { name: 'Synthetic isolation probe' }); await save(); }
  const token = state.keyA.token ?? state.keyA.key;
  assert.equal(typeof token, 'string', 'API key returned privately');
  const foreign = await request('GET', `/api/companies/${state.B.id}/agents`, undefined, token);
  assert.ok([403, 404].includes(foreign.status));
  results.push({ name: 'A agent cannot list B agents', pass: true, status: foreign.status });
  if (!state.run) { state.run = await ok('POST', `/api/agents/${state.agentA.id}/heartbeat/invoke`, {}); await save(); }
  let run;
  for (let i = 0; i < 40; i++) {
    run = await ok('GET', `/api/heartbeat-runs/${state.run.id}`);
    if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(run.status)) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  results.push({ name: 'Actual process adapter execution', status: run.status, result: run.resultJson, error: run.error });
  console.log(JSON.stringify({ stage: 'candidate baseline', results, candidateAccepted: false }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ stage: 'candidate baseline', results, error: error.message }, null, 2));
  process.exitCode = 1;
} finally { await save(); }
