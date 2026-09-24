import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

// Inside the disposable container only. All output is whitelisted; never print a bearer or raw payload.
const state = JSON.parse(await readFile('/paperclip/proof/root-session.json', 'utf8'));
const base = 'http://localhost:3100';
const result = { verifier: '/root/c0_verifier', level: 'SERVICE transport/capability; SIM HTTP receiver', checkedAt: new Date().toISOString() };
let stage = 'start', token, server, callbackFailure = false;
async function call(method, path, body, bearer) {
  const headers = { 'Content-Type': 'application/json' };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  else { headers.Origin = base; headers.Cookie = state.cookie; }
  const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
async function ok(method, path, body) {
  const r = await call(method, path, body);
  assert.ok(r.status >= 200 && r.status < 300, 'Fixture setup failed');
  return r.data;
}
try {
  const health = await ok('GET', '/api/health');
  assert.equal(health.commit, 'e006c18f2036d95d47ca8f7eb068670f3c54942d');
  result.commit = health.commit;
  const previous = JSON.parse(await readFile('/paperclip/proof/http-observed.json', 'utf8'));
  const previousToken = previous[0].body.paperclipRuntimeTools?.bearerToken;
  assert.equal(typeof previousToken, 'string');
  result.previousBodyBearerPresent = true;
  result.previousEndedTokenStatus = (await call('GET', '/mcp/runtime-tools', undefined, previousToken)).status;
  const suffix = randomBytes(8).toString('hex');
  stage = 'create disabled metadata';
  async function metadata(company, letter) {
    return ok('POST', `/api/companies/${company.id}/tools/connections`, {
      name: `ivtoken-${suffix}-${letter}`, applicationName: `ivtoken-${suffix}-${letter}`, transport: 'mcp_remote',
      authKind: 'none', enabled: false, status: 'draft', config: { url: 'https://93.184.216.34/mcp' },
    });
  }
  const aConnection = await metadata(state.A, 'A');
  const bConnection = await metadata(state.B, 'B');
  stage = 'create receiver';
  server = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      token = body.paperclipRuntimeTools?.bearerToken;
      assert.equal(typeof token, 'string');
      const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
      result.bodyBearerPresent = true;
      result.authorizationHeaderPresent = Boolean(req.headers.authorization);
      result.tokenScope = claims.scope;
      result.claimsMatchCompany = claims.company_id === state.A.id;
      result.claimsMatchAgent = claims.sub === body.agentId;
      result.claimsMatchRun = claims.run_id === body.runId;
      result.claimTtlSeconds = claims.exp - claims.iat;
      result.liveMcpStatus = (await call('GET', '/mcp/runtime-tools', undefined, token)).status;
      const search = await call('POST', '/runtime-tools/connections/search', { query: `ivtoken-${suffix}` }, token);
      result.liveSearchStatus = search.status;
      result.searchIncludesA = search.data.results?.some(row => row.service === `connection:${aConnection.id}`) ?? false;
      result.searchIncludesB = search.data.results?.some(row => row.service === `connection:${bConnection.id}`) ?? false;
      result.disabledARequestStatus = (await call('POST', '/runtime-tools/connections/request', { service: `connection:${aConnection.id}` }, token)).status;
      result.foreignBRequestStatus = (await call('POST', '/runtime-tools/connections/request', { service: `connection:${bConnection.id}` }, token)).status;
      result.generalCompanyApiStatus = (await call('GET', `/api/companies/${state.A.id}/agents`, undefined, token)).status;
      const tamperedClaims = { ...claims, company_id: state.B.id };
      const parts = token.split('.'); parts[1] = Buffer.from(JSON.stringify(tamperedClaims)).toString('base64url');
      result.tamperedCompanyStatus = (await call('GET', '/mcp/runtime-tools', undefined, parts.join('.'))).status;
      assert.equal(result.liveMcpStatus, 200);
      assert.equal(result.liveSearchStatus, 200);
      assert.equal(result.searchIncludesA, true);
      assert.equal(result.searchIncludesB, false);
      assert.equal(result.disabledARequestStatus, 422);
      assert.equal(result.foreignBRequestStatus, 404);
      assert.equal(result.tamperedCompanyStatus, 401);
    } catch { callbackFailure = true; }
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ accepted: true, workCompleted: false }));
  });
  await new Promise(resolve => server.listen(3555, '127.0.0.1', resolve));
  stage = 'create task run';
  const agent = await ok('POST', `/api/companies/${state.A.id}/agents`, {
    name: `Independent runtime token ${suffix}`, role: 'engineer', reportsTo: state.agentA.id, adapterType: 'http',
    adapterConfig: { url: 'http://127.0.0.1:3555/task', timeoutMs: 15000 },
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } }, permissions: { canCreateAgents: false },
  });
  const issue = await ok('POST', `/api/companies/${state.A.id}/issues`, {
    title: `IV runtime task ${suffix}`, status: 'backlog', assigneeAgentId: agent.id,
  });
  const invocation = await ok('POST', `/api/agents/${agent.id}/heartbeat/invoke`, { payload: { issueId: issue.id } });
  let run;
  for (let i = 0; i < 80; i++) {
    run = await ok('GET', `/api/heartbeat-runs/${invocation.id}`);
    if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(run.status)) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  result.runStatus = run.status;
  result.receiverExecutedWork = false;
  result.callbackChecksPassed = !callbackFailure;
  assert.equal(run.status, 'succeeded');
  assert.equal(typeof token, 'string');
  result.endedMcpStatus = (await call('GET', '/mcp/runtime-tools', undefined, token)).status;
  result.endedSearchStatus = (await call('POST', '/runtime-tools/connections/search', { query: `ivtoken-${suffix}` }, token)).status;
  assert.equal(result.endedMcpStatus, 403);
  assert.equal(result.endedSearchStatus, 403);
  assert.equal(callbackFailure, false);
  result.probeCompleted = true;
  result.executorOsIsolationVerified = false;
  console.log(JSON.stringify(result, null, 2));
} catch {
  result.probeCompleted = false;
  result.failureStage = stage;
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = 1;
} finally { server?.close(); }
