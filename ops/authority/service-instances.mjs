import assert from 'node:assert/strict';
import { anyApi } from 'convex/server';

export async function replayInstances({ runtime, test }) {
  await test('Same external ID under different provider instances stays isolated per connection', async () => {
    const a = runtime.client('instances-owner-a'), b = runtime.client('instances-owner-b');
    await a.mutation(anyApi.users.store, {}); await b.mutation(anyApi.users.store, {});
    const orgA = await a.mutation(anyApi.orgs.create, { name: 'Instances A' }), orgB = await b.mutation(anyApi.orgs.create, { name: 'Instances B' });
    runtime.run('integrations/connections:registerProvider', { provider: 'fake2', enabled: true });
    for (const orgId of [orgA, orgB]) runtime.run('integrations/budgets:configure', { orgId, cap: 100, maxConcurrent: 10, maxPerRun: 20, maxSteps: 3, maxRecipients: 10 });
    const connect = async (human, orgId, provider, environment, account, label) => {
      const secretReferenceId = runtime.run('integrations/connections:registerSecret', { orgId, provider, environment, account, handle: `vault:00000000-0000-0000-0000-${label.padStart(12, '0')}` });
      const connection = await human.action(anyApi['integrations/connections'].connect, { orgId, secretReferenceId });
      const intentId = await human.mutation(anyApi['integrations/bindings'].provision, { orgId, connectionId: connection.connectionId, logical: 'recipient-' + label, recipient: 'recipient-' + label, kind: 'recipient', remove: false });
      const request = async (name, body, key = connection.adapterKey) => fetch(runtime.site + '/api/integrations/v1/' + name, { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const bound = await request('bind', { intentId, externalId: 'shared-external-id' }); assert.equal(bound.status, 200); const { bindingId } = await bound.json();
      return { orgId, human, ...connection, intentId, bindingId, request };
    };
    const c1 = await connect(a, orgA, 'fake', 'test', 'X', '1');
    const c2 = await connect(a, orgA, 'fake', 'test', 'Y', '2');
    const c3 = await connect(a, orgA, 'fake2', 'test', 'X', '3');
    const c4 = await connect(a, orgA, 'fake', 'live-sim', 'X', '4');
    const c5 = await connect(b, orgB, 'fake', 'test', 'Z', '5');
    assert.equal(new Set([c1, c2, c3, c4, c5].map(c => c.bindingId)).size, 5);
    for (const foreign of [c2, c3, c4, c5]) assert.ok([403, 404].includes((await c1.request('callback', { bindingId: foreign.bindingId, eventId: 'foreign', body: JSON.stringify({ version: 1, state: 'suppressed', channel: 'email', purpose: 'marketing' }) })).status));
    const payload = { content: 'synthetic', audience: [], audienceVersion: 1, destination: 'X', schedule: 0, amountMinor: 0, currency: 'USD', workflowVersion: 1 };
    const operation = await a.mutation(anyApi['integrations/commands'].proposeHuman, { orgId: orgA, logical: 'c2-op', bindingId: c2.bindingId, capability: 'model.call', payload: { ...payload, destination: 'Y' }, reservationUnits: 1, maxSteps: 1 });
    await a.mutation(anyApi['integrations/commands'].approve, { orgId: orgA, id: operation, expiresAt: Date.now() + 60000 }); const claim = await a.mutation(anyApi['integrations/commands'].claimHuman, { orgId: orgA, id: operation, worker: 'instances' });
    assert.ok([403, 404].includes((await c1.request('status', { id: operation, ...claim })).status));
    assert.ok([403, 404].includes((await c1.request('permit', { id: operation, ...claim, worker: 'instances' })).status));
    runtime.run('authorityFixture:consent', { orgId: orgA, recipient: 'recipient-1' }); runtime.run('authorityFixture:consent', { orgId: orgA, recipient: 'recipient-2' });
    assert.equal((await c1.request('callback', { bindingId: c1.bindingId, eventId: 'own', body: JSON.stringify({ version: 2, state: 'suppressed', channel: 'email', purpose: 'marketing' }) })).status, 200);
    assert.deepEqual(runtime.run('authorityFixture:dump', { orgId: orgA }).consent.map(x => [x.recipient, x.suppressed]).sort(), [['recipient-1', true], ['recipient-2', false]]);
    assert.equal((await a.query(anyApi['integrations/connections'].list, { orgId: orgA })).some(x => x.id === c5.connectionId), false);
    await assert.rejects(a.mutation(anyApi['integrations/commands'].proposeHuman, { orgId: orgA, logical: 'foreign-binding', bindingId: c5.bindingId, capability: 'model.call', payload: { ...payload, destination: 'Z' }, reservationUnits: 1, maxSteps: 1 }), /not found|NOT_FOUND/i);
    const differentIntent = await a.mutation(anyApi['integrations/bindings'].provision, { orgId: orgA, connectionId: c1.connectionId, logical: 'collision', recipient: 'different-recipient', kind: 'recipient', remove: false });
    assert.equal((await c1.request('bind', { intentId: differentIntent, externalId: 'shared-external-id' })).status, 409);
  });
}
