import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

const base = 'http://localhost:3100';
const state = JSON.parse(await readFile('/tmp/remold-proof-session.json', 'utf8'));
const result = { verifier: '/root/c0_verifier', level: 'SERVICE', checkedAt: new Date().toISOString() };
async function request(method, path, body, token) {
  const headers = { Origin: base, 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  else headers.Cookie = state.cookie;
  const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}
async function ok(method, path, body, token) {
  const response = await request(method, path, body, token);
  assert.ok(response.status >= 200 && response.status < 300, 'Expected successful fixture setup');
  return response.data;
}
try {
  const suffix = randomBytes(8).toString('hex');
  const health = await ok('GET', '/api/health');
  assert.equal(health.commit, 'e006c18f2036d95d47ca8f7eb068670f3c54942d');
  result.commit = health.commit;
  const createAgent = name => ok('POST', `/api/companies/${state.A.id}/agents`, {
    name: `${name} ${suffix}`, role: 'engineer', adapterType: 'process',
    adapterConfig: { command: '/usr/local/bin/node', args: ['-e', 'process.exit(0)'], timeoutSec: 5 },
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
    permissions: { canCreateAgents: false }, budgetMonthlyCents: 0,
  });
  const a1 = await createAgent('IV A1 reader');
  const a2 = await createAgent('IV A2 assigned owner');
  const marker = `A2-only-intended-synthetic-${randomBytes(20).toString('hex')}`;
  const issue = await ok('POST', `/api/companies/${state.A.id}/issues`, {
    title: `IV intended A2-only ${suffix}`, description: marker, status: 'backlog', assigneeAgentId: a2.id,
  });
  assert.equal(issue.assigneeAgentId, a2.id);
  const key = await ok('POST', `/api/agents/${a1.id}/keys`, { name: 'IV ordinary agent credential' });
  const token = key.token ?? key.key;
  assert.equal(typeof token, 'string');
  const agents = await request('GET', `/api/companies/${state.A.id}/agents`, undefined, token);
  const issues = await request('GET', `/api/companies/${state.A.id}/issues`, undefined, token);
  const direct = await request('GET', `/api/issues/${issue.id}`, undefined, token);
  const foreign = await request('GET', `/api/companies/${state.B.id}/agents`, undefined, token);
  const asRows = data => Array.isArray(data) ? data : data.issues ?? data.items ?? data.data ?? [];
  result.agentRole = 'engineer';
  result.canCreateAgents = false;
  result.credentialKind = 'ordinary agent API key, not specialized skill-test token';
  result.assigneeIsA2 = issue.assigneeAgentId === a2.id;
  result.sameCompanyAgentListStatus = agents.status;
  result.agentListContainsA2 = asRows(agents.data).some(row => row.id === a2.id);
  result.sameCompanyIssueListStatus = issues.status;
  result.issueListContainsA2Issue = asRows(issues.data).some(row => row.id === issue.id);
  result.directA2IssueStatus = direct.status;
  result.directA2DescriptionExact = direct.data.description === marker;
  result.foreignCompanyListStatus = foreign.status;
  result.issueId = issue.id;
  result.probeCompleted = true;
  result.recordScopeAccepted = !result.agentListContainsA2 && !result.issueListContainsA2Issue && !result.directA2DescriptionExact;
  console.log(JSON.stringify(result, null, 2));
} catch {
  result.probeCompleted = false;
  result.error = 'Scope probe failed; raw payloads suppressed.';
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = 1;
}
