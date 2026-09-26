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
  const key = await ok('POST', `/api/agents/${a1.id}/keys`, { name: 'IV ordinary comparison credential' });
  const token = key.token ?? key.key;
  assert.equal(typeof token, 'string');
  const agents = await request('GET', `/api/companies/${state.A.id}/agents`, undefined, token);
  const issues = await request('GET', `/api/companies/${state.A.id}/issues`, undefined, token);
  const direct = await request('GET', `/api/issues/${issue.id}`, undefined, token);
  const foreign = await request('GET', `/api/companies/${state.B.id}/agents`, undefined, token);
  const asRows = data => Array.isArray(data) ? data : data.issues ?? data.items ?? data.data ?? [];
  const ownIssue = await ok('POST', `/api/companies/${state.A.id}/issues`, {
    title: `IV task-bridge own ${suffix}`, description: 'Synthetic A1 in-scope', status: 'backlog', assigneeAgentId: a1.id,
  });
  const bIssue = await ok('POST', `/api/companies/${state.B.id}/issues`, {
    title: `IV task-bridge foreign ${suffix}`, description: 'Synthetic B out-of-scope', status: 'backlog',
  });
  const scopedKey = await ok('POST', `/api/agents/${a1.id}/keys`, {
    name: 'Independent task bridge', scope: { kind: 'task_bridge', parentIssueId: ownIssue.id, allowedAssigneeAgentIds: [a1.id] },
  });
  const scoped = scopedKey.token ?? scopedKey.key;
  assert.equal(typeof scoped, 'string');
  const ownRead = await request('GET', `/api/issues/${ownIssue.id}`, undefined, scoped);
  const scopedAgents = await request('GET', `/api/companies/${state.A.id}/agents`, undefined, scoped);
  const scopedIssues = await request('GET', `/api/companies/${state.A.id}/issues`, undefined, scoped);
  const scopedA2 = await request('GET', `/api/issues/${issue.id}`, undefined, scoped);
  const scopedB = await request('GET', `/api/issues/${bIssue.id}`, undefined, scoped);
  const scopedBList = await request('GET', `/api/companies/${state.B.id}/agents`, undefined, scoped);
  result.scope = { kind: 'task_bridge', parentIssueId: ownIssue.id, allowedAssigneeAgentIds: [a1.id] };
  result.positiveOwnIssueStatus = ownRead.status;
  result.positiveOwnIssueExact = ownRead.data.description === 'Synthetic A1 in-scope';
  result.standardKeyA2ReadStatus = direct.status;
  result.standardKeyA2Exact = direct.data.description === marker;
  result.sameCompanyAgentListStatus = scopedAgents.status;
  result.agentListContainsA2 = asRows(scopedAgents.data).some(row => row.id === a2.id);
  result.sameCompanyIssueListStatus = scopedIssues.status;
  result.directA2IssueStatus = scopedA2.status;
  result.directA2DescriptionExact = scopedA2.data.description === marker;
  result.directBIssueStatus = scopedB.status;
  result.foreignCompanyListStatus = scopedBList.status;
  result.probeCompleted = true;
  result.recordScopeAccepted = ownRead.status === 200 && result.positiveOwnIssueExact
    && !result.agentListContainsA2 && [403,404].includes(scopedIssues.status)
    && [403,404].includes(scopedA2.status) && [403,404].includes(scopedB.status) && scopedBList.status === 403;
  console.log(JSON.stringify(result, null, 2));
} catch {
  result.probeCompleted = false;
  result.error = 'Scope probe failed; raw payloads suppressed.';
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = 1;
}
