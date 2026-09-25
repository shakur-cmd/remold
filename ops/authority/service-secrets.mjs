import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { anyApi } from 'convex/server';

const response = async (runtime, path, key, body) => {
  const r = await fetch(runtime.site + path, { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, text: await r.text() };
};

export async function replaySecrets({ runtime, tenant, test }) {
  await test('Invalid provider and secret references fail closed', async () => {
    const t = await tenant('secret-reference');
    const canary = randomUUID(), raw = 'sk_test_' + canary;
    let refusal = '';
    try { runtime.run('integrations/connections:registerSecret', { orgId: t.orgId, provider: 'fake', environment: 'test', account: 'raw-reference', handle: raw }); } catch (error) { refusal = String(error.stderr ?? '') + String(error.stdout ?? ''); } // The thrown message repeats our own command line; only server output counts.
    assert.ok(refusal); assert.ok(!refusal.includes(canary));
    const other = await tenant('secret-foreign');
    await assert.rejects(t.human.action(anyApi['integrations/connections'].connect, { orgId: t.orgId, secretReferenceId: other.secretReferenceId }));
    assert.equal((await t.human.query(anyApi['integrations/connections'].list, { orgId: t.orgId })).length, 1);
    runtime.run('integrations/connections:registerProvider', { provider: 'secret-disabled', enabled: true });
    const disabledRef = runtime.run('integrations/connections:registerSecret', { orgId: t.orgId, provider: 'secret-disabled', environment: 'test', account: 'disabled-' + canary, handle: 'vault:' + randomUUID() });
    runtime.run('integrations/connections:registerProvider', { provider: 'secret-disabled', enabled: false });
    await assert.rejects(t.human.action(anyApi['integrations/connections'].connect, { orgId: t.orgId, secretReferenceId: disabledRef }));
    const id = await t.propose('secret-disabled-claim', 1, 1);
    runtime.run('integrations/connections:registerProvider', { provider: 'fake', enabled: false });
    await assert.rejects(t.claim(id), /Provider is not enabled/);
    runtime.run('integrations/connections:registerProvider', { provider: 'fake', enabled: true });
    const mismatch = await t.propose('secret-mismatch-claim', 1, 1);
    runtime.run('authorityFixture:patchSecretAccount', { id: t.secretReferenceId, account: 'changed-' + canary });
    await assert.rejects(t.claim(mismatch), /reconnection/i);
    // The queued operation makes revocation testable even though new provisioning is correctly closed.
    runtime.run('authorityFixture:patchSecretAccount', { id: t.secretReferenceId, account: t.account });
    const revoked = await t.propose('secret-revoked-claim', 1, 1);
    runtime.run('authorityFixture:revokeSecret', { id: t.secretReferenceId });
    await assert.rejects(t.claim(revoked), /reconnection/i);
    assert.equal((await response(runtime, '/api/integrations/v1/permit', 'ra_not-a-key', {})).status, 401);
    // A well-formed but unknown key with otherwise valid permit arguments must not authenticate.
    const fresh = await tenant('secret-unknown-key'), queued = await fresh.propose('unknown-key', 1, 1), held = await fresh.claim(queued), before = await fresh.get(queued);
    assert.equal((await response(runtime, '/api/integrations/v1/permit', 'ra_' + '0'.repeat(64), { id: queued, ...held, worker: 'worker' })).status, 401);
    assert.deepEqual(await fresh.get(queued), before);
  });

  await test('Callback, adapter, REST and ops logs reveal no secrets', async () => {
    const t = await tenant('secret-hygiene'), canary = randomUUID();
    // Replace only the synthetic opaque reference, keeping the connection tuple valid.
    const secret = runtime.run('integrations/connections:registerSecret', { orgId: t.orgId, provider: 'fake', environment: 'test', account: 'hygiene-account', handle: 'vault:' + canary });
    const connection = await t.human.action(anyApi['integrations/connections'].connect, { orgId: t.orgId, secretReferenceId: secret });
    const intent = await t.human.mutation(anyApi['integrations/bindings'].provision, { orgId: t.orgId, connectionId: connection.connectionId, logical: 'hygiene', recipient: 'hygiene-recipient', kind: 'recipient', remove: false });
    const texts = [], adapter = async (path, key, body) => { const r = await response(runtime, path, key, body); texts.push(r.text); return r; };
    const bound = await adapter('/api/integrations/v1/bind', connection.adapterKey, { intentId: intent, externalId: 'hygiene' }); const bindingId = JSON.parse(bound.text).bindingId;
    const body = JSON.stringify({ version: 1, state: 'suppressed', channel: 'email', purpose: 'marketing' });
    await adapter('/api/integrations/v1/callback', connection.adapterKey, { bindingId, eventId: 'one', body });
    await adapter('/api/integrations/v1/callback', connection.adapterKey, { bindingId, eventId: 'one', body });
    await adapter('/api/integrations/v1/callback', connection.adapterKey, { bindingId, eventId: 'one', body: body.replace('suppressed', 'active') });
    await adapter('/api/integrations/v1/callback', connection.adapterKey, { bad: true });
    await adapter('/api/integrations/v1/permit', 'ra_' + '0'.repeat(64), {});
    const agent = await t.human.action(anyApi.agents.create, { orgId: t.orgId, name: 'secret-log-agent', role: 'admin', grants: [{ action: 'create', objectKey: '*' }] });
    texts.push((await response(runtime, '/api/v1/changes', agent.key, { bad: true })).text);
    runtime.run('authorityFixture:revokeSecret', { id: secret });
    try { await t.human.mutation(anyApi['integrations/bindings'].provision, { orgId: t.orgId, connectionId: connection.connectionId, logical: 'after-revoke', recipient: 'after', kind: 'recipient', remove: false }); } catch (error) { texts.push(String(error)); }
    const fixture = runtime.exportFixture();
    const files = execFileSync('unzip', ['-Z1', fixture.path], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    // secretReferences is the one table allowed to hold the opaque handle; keys are stored only as hashes.
    const scannedTables = files.filter(file => !/^secretReferences\//.test(file));
    const exportText = scannedTables.map(file => execFileSync('unzip', ['-p', fixture.path, file], { encoding: 'utf8' })).join('\n');
    for (const value of [canary, connection.adapterKey, agent.key]) {
      assert.ok(!texts.join('\n').includes(value), 'response/error leaked secret');
      assert.ok(!runtime.logs().includes(value), 'backend/function log leaked secret');
      assert.ok(!exportText.includes(value), 'fixture table leaked secret');
    }
    console.log('SCANNED SECRET-HYGIENE TABLES', scannedTables.join(','));
  });
}
