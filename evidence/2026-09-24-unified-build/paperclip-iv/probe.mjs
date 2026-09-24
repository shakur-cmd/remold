import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';

// Run only inside the disposable candidate container. Never emit credentials or raw logs.
const base = 'http://localhost:3100';
const state = JSON.parse(await readFile('/tmp/remold-proof-session.json', 'utf8'));
const results = { verifier: '/root/c0_verifier', level: 'SERVICE', checkedAt: new Date().toISOString() };
async function request(method, path, body, token) {
  const headers = { Origin: base, 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  else headers.Cookie = state.cookie;
  const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}
async function ok(method, path, body, token) {
  const response = await request(method, path, body, token);
  assert.ok(response.status >= 200 && response.status < 300, `${method} request returned ${response.status}`);
  return response.data;
}
try {
  const health = await ok('GET', '/api/health');
  assert.equal(health.commit, 'e006c18f2036d95d47ca8f7eb068670f3c54942d');
  assert.equal(health.deploymentMode, 'authenticated');
  results.commit = health.commit;
  const suffix = randomBytes(8).toString('hex');
  const directory = `/tmp/remold-iv-tenant-b-${suffix}`;
  const sentinel = `${directory}/private-synthetic.txt`;
  const marker = `independent-synthetic-b-${randomBytes(24).toString('hex')}`;
  const expectedHash = createHash('sha256').update(marker).digest('hex');
  await mkdir(directory, { mode: 0o700 });
  await writeFile(sentinel, marker, { mode: 0o600 });
  const code = `const fs=require('node:fs'),crypto=require('node:crypto');let bFileExactReadable=false;try{bFileExactReadable=crypto.createHash('sha256').update(fs.readFileSync(${JSON.stringify(sentinel)})).digest('hex')===${JSON.stringify(expectedHash)}}catch{};console.log(JSON.stringify({bFileExactReadable,authSecretInherited:Boolean(process.env.BETTER_AUTH_SECRET),hostHomeMounted:fs.existsSync('/Users/urkel'),apiTokenPresent:Boolean(process.env.PAPERCLIP_API_KEY),runtimeUid:process.getuid()}));`;
  const agent = await ok('POST', `/api/companies/${state.A.id}/agents`, {
    name: `Independent read-only runtime ${suffix}`, role: 'ceo', adapterType: 'process',
    adapterConfig: { command: '/usr/local/bin/node', args: ['-e', code], cwd: '/tmp', timeoutSec: 15 },
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
    permissions: { canCreateAgents: false }, budgetMonthlyCents: 0,
  });
  const key = await ok('POST', `/api/agents/${agent.id}/keys`, { name: 'Independent synthetic probe' });
  const token = key.token ?? key.key;
  assert.equal(typeof token, 'string');
  const foreign = await request('GET', `/api/companies/${state.B.id}/agents`, undefined, token);
  assert.equal(foreign.status, 403);
  results.foreignCompanyListStatus = foreign.status;
  const invocation = await ok('POST', `/api/agents/${agent.id}/heartbeat/invoke`, {});
  let run;
  for (let i = 0; i < 60; i++) {
    run = await ok('GET', `/api/heartbeat-runs/${invocation.id}`);
    if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(run.status)) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal(run.status, 'succeeded');
  const observed = JSON.parse(run.resultJson.stdout.trim());
  for (const key of ['bFileExactReadable', 'authSecretInherited', 'hostHomeMounted', 'apiTokenPresent']) {
    assert.equal(typeof observed[key], 'boolean');
    results[key] = observed[key];
  }
  results.runtimeUid = observed.runtimeUid;
  results.runStatus = run.status;
  results.agentId = agent.id;
  results.runId = run.id;
  results.sentinelSha256 = expectedHash;
  results.fixturePermissions = { directory: '0700', file: '0600' };
  assert.equal(observed.hostHomeMounted, false);
  assert.equal(observed.apiTokenPresent, true);
  results.isolationAccepted = !observed.bFileExactReadable && !observed.authSecretInherited;
  results.probeCompleted = true;
  console.log(JSON.stringify(results, null, 2));
} catch {
  results.probeCompleted = false;
  results.error = 'Probe did not complete; no raw response or credential-bearing error emitted.';
  console.log(JSON.stringify(results, null, 2));
  process.exitCode = 1;
}
