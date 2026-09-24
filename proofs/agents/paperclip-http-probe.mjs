import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';

const state = JSON.parse(await readFile('/paperclip/proof/root-session.json', 'utf8'));
const base = 'http://localhost:3100';
const received = [];
// This trusted receiver deliberately accepts without executing work. It tests
// transport semantics, not operating-system isolation of a model executor.
const server = createServer(async (req, res) => {
  let text = '';
  for await (const chunk of req) text += chunk;
  received.push({ headers: req.headers, body: JSON.parse(text) });
  res.writeHead(202, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ accepted: true, completed: false }));
});
await new Promise(resolve => server.listen(3555, '127.0.0.1', resolve));
async function request(method, path, body) {
  const r = await fetch(base + path, { method, headers: { Origin: base, Cookie: state.cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json();
  assert.ok(r.ok, `${method} ${path}: ${r.status} ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}
try {
  const agent = await request('POST', `/api/companies/${state.A.id}/agents`, { name: 'Synthetic HTTP receiver A', role: 'engineer', reportsTo: state.agentA.id, adapterType: 'http', adapterConfig: { url: 'http://127.0.0.1:3555/task', timeoutMs: 5000 }, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } }, permissions: { canCreateAgents: false } });
  const invocation = await request('POST', `/api/agents/${agent.id}/heartbeat/invoke`, {});
  let run;
  for (let i = 0; i < 40; i++) {
    run = await request('GET', `/api/heartbeat-runs/${invocation.id}`);
    if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(run.status)) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(received.length, 1, 'One real HTTP request');
  const serialized = JSON.stringify(received);
  const secret = process.env.BETTER_AUTH_SECRET;
  const result = {
    pin: 'e006c18f2036d95d47ca8f7eb068670f3c54942d', level: 'SERVICE candidate HTTP transport; SIM receiver',
    requestCount: received.length, headerNames: Object.keys(received[0].headers), bodyKeys: Object.keys(received[0].body),
    contextKeys: Object.keys(received[0].body.context ?? {}),
    receiverExecutedWork: false, receiverStatus: 202, paperclipRunStatus: run.status,
    inheritedSecretForwarded: Boolean(secret && serialized.includes(secret)),
    serverAuthCookieForwarded: serialized.includes(state.cookie),
    otherCompanyIdForwarded: serialized.includes(state.B.id),
    perRunBearerPresent: Boolean(received[0].headers.authorization),
    runtimeToolsBearerPresent: typeof received[0].body.paperclipRuntimeTools?.bearerToken === 'string',
    executorIsolationVerified: false,
  };
  assert.equal(result.inheritedSecretForwarded, false);
  assert.equal(result.serverAuthCookieForwarded, false);
  assert.equal(result.otherCompanyIdForwarded, false);
  await writeFile('/paperclip/proof/http-observed.json', serialized, { mode: 0o600 });
  console.log(JSON.stringify(result, null, 2));
} finally { server.close(); }
