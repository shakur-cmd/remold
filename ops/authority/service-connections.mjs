import assert from 'node:assert/strict';
import { anyApi } from 'convex/server';
export async function replayConnections({ runtime, tenant, test }) {
  const setup = async label => {
    const t = await tenant(label);
    const provision = (logical, recipient, remove = false) => t.human.mutation(anyApi['integrations/bindings'].provision, { orgId: t.orgId, connectionId: t.connectionId, logical, recipient, kind: 'recipient', remove });
    const bind = async (logical, recipient, externalId = logical) => { const intentId = await provision(logical, recipient); return t.adapter('bind', { intentId, externalId }); };
    return { ...t, provision, bind };
  };
  await test('Actual authenticated callback payload deduplicates, rejects changed content and scopes suppression to recipient/channel/purpose', async () => {
    const t = await setup('callbacks'), a = await t.bind('a', 'recipient-A'), b = await t.bind('b', 'recipient-B'), foreign = await setup('foreign-callbacks');
    for (const recipient of ['recipient-A', 'recipient-B']) runtime.run('authorityFixture:consent', { orgId: t.orgId, recipient });
    const body = JSON.stringify({ version: 2, state: 'suppressed', channel: 'email', purpose: 'marketing' });
    const args = { bindingId: a.bindingId, eventId: 'event-1', body };
    const concurrent = await Promise.all([t.adapter('callback', args), t.adapter('callback', args)]);
    assert.deepEqual(concurrent.sort(), ['applied', 'duplicate']);
    await assert.rejects(t.adapter('callback', { ...args, body: JSON.stringify({ version: 2, state: 'active' }) }), /409/);
    await assert.rejects(foreign.adapter('callback', args), /404|403/);
    await t.adapter('callback', { ...args, eventId: 'old', body: JSON.stringify({ version: 1, state: 'active' }) });
    assert.deepEqual(t.dump().consent.map(c => [c.recipient, c.channel, c.purpose, c.suppressed]).sort(), [['recipient-A', 'email', 'marketing', true], ['recipient-B', 'email', 'marketing', false]]);
    await t.adapter('callback', { bindingId: b.bindingId, eventId: 'event-1', body: JSON.stringify({ version: 2, state: 'suppressed', channel: 'sms', purpose: 'service' }) });
    assert.deepEqual(t.dump().consent.map(c => [c.recipient, c.channel, c.purpose, c.suppressed]).sort(), [['recipient-A', 'email', 'marketing', true], ['recipient-B', 'email', 'marketing', false], ['recipient-B', 'sms', 'service', true]]);
    const suppressed = await t.propose('suppressed', 1, 1, { capability: 'marketing.send', payload: { ...t.payload, audience: ['recipient-A'] } });
    await assert.rejects(t.permit(suppressed), /Consent/);
    const allowed = await t.propose('different-purpose', 1, 1, { capability: 'marketing.send', payload: { ...t.payload, audience: ['recipient-B'] } });
    await t.permit(allowed); await t.cancel(allowed);
  });
  await test('Provision deletion wins before and after acknowledgement; tuple collision cannot replace recipient', async () => {
    const t = await setup('provision'), intentId = await t.provision('race', 'A'); await t.provision('race', 'A', true);
    assert.deepEqual(await t.adapter('bind', { intentId, externalId: 'late' }), { cleanupRequired: true, bindingId: null });
    const one = await t.bind('one', 'A', 'same'); await assert.rejects(t.bind('two', 'B', 'same'), /collision/);
    await t.provision('one', 'A', true); assert.equal(t.dump().bindings.find(b => b._id === one.bindingId).connected, false);
    const prior = await t.provision('one', 'A'); assert.deepEqual(await t.adapter('bind', { intentId: prior, externalId: 'same' }), { cleanupRequired: true, bindingId: null });
  });
  await test('Durable cursor keeps partial checkpoint, rejects page gaps and permits only the next committed traversal', async () => {
    const t = await setup('cursor'), a = await t.bind('page', 'A');
    const args = { resource: 'recipients', traversal: 'first', from: 0, page: 1, items: [{ bindingId: a.bindingId, observation: { version: 1, state: 'active' } }], end: false, checkpoint: 10 };
    assert.equal(await t.adapter('page', args), 0); assert.equal(await t.adapter('page', args), 0);
    await assert.rejects(t.adapter('page', { ...args, page: 3 }), /409/);
    assert.equal(await t.adapter('page', { ...args, page: 2, items: [], end: true }), 10);
    await assert.rejects(t.adapter('page', { ...args, traversal: 'second', from: 0 }), /409/);
    assert.equal(await t.adapter('page', { ...args, traversal: 'second', from: 10, checkpoint: 20, end: true }), 20);
  });
}
