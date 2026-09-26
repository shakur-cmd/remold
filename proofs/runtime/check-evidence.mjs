import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const base = new URL('./', import.meta.url);
const read = path => readFile(new URL(path, base), 'utf8');
const sourceManifest = JSON.parse(await read('schema/provenance.json'));
for (const [name, expected] of Object.entries(sourceManifest.files)) {
  const actual = createHash('sha256').update(await read(`schema/${name}`)).digest('hex');
  assert.equal(actual, expected, `Generated schema changed: ${name}`);
}
const result = JSON.parse(await read('evidence/lifecycle.json'));
function verify(r) {
  assert.equal(r.account.type, 'chatgpt');
  assert.equal(r.configured.model, 'gpt-6-luna');
  assert.equal(r.thread.model, r.configured.model);
  assert.equal(r.thread.sandbox.type, 'readOnly');
  assert.equal(r.thread.sandbox.networkAccess, false);
  assert.equal(r.thread.approvalPolicy, 'never');
  assert.equal(r.toolItems, 0);
  assert.equal(r.preHandshakeRefused, true);
  assert.equal(r.events.filter(e => e.method === 'turn/start' && e.kind === 'request').length, 2);
  assert.equal(r.completion.output, 'RUNTIME_OK');
  for (const turn of [r.completion, r.interruption]) {
    assert(r.events.some(e => e.method === 'turn/started' && e.turnId === turn.turnId));
    assert(r.events.some(e => e.method === 'turn/completed' && e.turnId === turn.turnId && e.status === turn.status));
  }
  assert.equal(r.completion.status, 'completed');
  assert.equal(r.interruption.status, 'interrupted');
  assert.equal(r.interruption.streamObserved, false);
  assert.equal(r.marginalDollarCost, 'unknown');
  assert(r.events.some(e => e.kind === 'exit'), 'Runner must stop its app-server');
  return true;
}
verify(result);
// Exercise the checker against real captured evidence with the essential outcomes removed.
for (const status of ['completed', 'interrupted']) {
  const altered = structuredClone(result);
  altered.events = altered.events.filter(e => !(e.method === 'turn/completed' && e.status === status));
  assert.throws(() => verify(altered), `Missing ${status} evidence must fail`);
}
console.log('PASS: captured lifecycle, subscription route, exact model, sandbox, shutdown and schema hashes; both missing-terminal evidence mutations refused. No inference performed.');
