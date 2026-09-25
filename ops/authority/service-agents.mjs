import assert from 'node:assert/strict';
import { anyApi } from 'convex/server';
import { ConvexClient } from 'convex/browser';
const pause = ms => new Promise(r => setTimeout(r, ms));
export async function replayAgents({ runtime, tenant, test }) {
  const rest = key => async (method, path, body) => { const response = await fetch(runtime.site + '/api/v1/' + path, { method, headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const data = await response.json(); if (!response.ok) throw new Error(response.status + ':' + JSON.stringify(data)); return data; };
  const grant = (t, agentId, capability, scope, extra = {}) => t.human.mutation(anyApi['authority/grants'].grant, { orgId: t.orgId, target: agentId, capability, scope, mode: 'direct', delegate: true, expiresAt: Date.now() + 60000, ...extra });
  await test('External scoped agent uses actual HTTP authority; firing stops new permits and preserves one issued tail', async () => {
    const t = await tenant('agent-fire'), agent = await t.human.action(anyApi.agents.createScoped, { orgId: t.orgId, name: 'scoped', origin: 'external' }), call = rest(agent.key);
    const proposal = { logical: 'agent-run', bindingId: t.bindingId, capability: 'model.call', payload: t.payload, reservationUnits: 5, maxSteps: 2 };
    await assert.rejects(call('POST', 'operations', proposal), /External capability denied/);
    await grant(t, agent.agentId, 'model.call', { kind: 'model', maxUnitsPerRun: 5, maxSteps: 2 });
    const id = await call('POST', 'operations', proposal), claimed = await call('POST', 'operations/' + id + '/claim', { worker: 'agent-worker' });
    const permit = await t.adapter('permit', { id, ...claimed, worker: 'agent-worker' });
    await t.human.mutation(anyApi.agents.revoke, { orgId: t.orgId, agentId: agent.agentId });
    const { expires, maxUnits, maxRecipients, ...args } = permit; await t.adapter('consume', args);
    assert.equal((await t.adapter('status', { id, ...claimed })).cancel, true);
    const result = await t.adapter('reconcile', { id, ...claimed, providerRef: 'late-agent', usage: 1, continue: true }); assert.equal(result.late, true); assert.equal(result.continuationRefused, true);
    await assert.rejects(call('POST', 'operations/' + id + '/claim', { worker: 'agent-worker' }), /revoked agent key/);
    const before = await t.human.action(anyApi.agents.createScoped, { orgId: t.orgId, name: 'before', origin: 'external' }), beforeCall = rest(before.key);
    await grant(t, before.agentId, 'model.call', { kind: 'model', maxUnitsPerRun: 5, maxSteps: 2 });
    const pending = await beforeCall('POST', 'operations', { ...proposal, logical: 'before' }), c = await beforeCall('POST', 'operations/' + pending + '/claim', { worker: 'w' });
    await t.human.mutation(anyApi.agents.revoke, { orgId: t.orgId, agentId: before.agentId }); await assert.rejects(t.adapter('permit', { id: pending, ...c, worker: 'w' }));
    await pause(300); assert.equal((await t.get(pending)).state, 'paused');
  });
  await test('Delegation revocation changes actual REST read projection while independent human grants survive', async () => {
    const t = await tenant('grant-chain'), objects = await t.human.query(anyApi.objects.list, { orgId: t.orgId }), company = objects.find(o => o.key === 'company');
    const detail = await t.human.query(anyApi.objects.get, { orgId: t.orgId, objectId: company._id }), name = detail.fields.find(f => f.key === 'name'), city = detail.fields.find(f => f.key === 'city');
    const row = await t.human.mutation(anyApi.records.create, { orgId: t.orgId, objectId: company._id, values: { [name._id]: 'Allowed name', [city._id]: 'Independent city' } });
    const manager = await t.human.action(anyApi.agents.createScoped, { orgId: t.orgId, name: 'manager', origin: 'external' }), child = await t.human.action(anyApi.agents.createScoped, { orgId: t.orgId, name: 'child', origin: 'external' });
    const scope = { kind: 'records', objectId: company._id, records: [row.recordId], fields: [name._id] };
    const parent = await grant(t, manager.agentId, 'read', scope); await grant(t, manager.agentId, 'agent.manage', { kind: 'agents', agents: [child.agentId] });
    await rest(manager.key)('POST', 'authority/grant', { target: child.agentId, capability: 'read', scope, mode: 'direct', delegate: false, expiresAt: Date.now() + 30000, parent });
    await grant(t, child.agentId, 'read', { ...scope, fields: [city._id] }); const childRead = () => rest(child.key)('GET', 'records/' + row.recordId);
    assert.deepEqual((await childRead()).record.values, { name: 'Allowed name', city: 'Independent city' });
    await grant(t, child.agentId, 'agent.manage', { kind: 'agents', agents: [manager.agentId] });
    await assert.rejects(rest(child.key)('POST', 'authority/fire', { target: manager.agentId }), /ancestor/);
    const modelScope = { kind: 'model', maxUnitsPerRun: 5, maxSteps: 1 }, modelParent = await grant(t, manager.agentId, 'model.call', modelScope);
    await rest(manager.key)('POST', 'authority/grant', { target: child.agentId, capability: 'model.call', scope: modelScope, mode: 'direct', delegate: false, expiresAt: Date.now() + 30000, parent: modelParent });
    const operation = await rest(child.key)('POST', 'operations', { logical: 'descendant-model', bindingId: t.bindingId, capability: 'model.call', payload: t.payload, reservationUnits: 5, maxSteps: 1 });
    await t.human.mutation(anyApi['authority/grants'].revoke, { orgId: t.orgId, id: parent }); assert.deepEqual((await childRead()).record.values, { city: 'Independent city' }); assert.equal((await childRead()).record.title, '');
    await assert.rejects(rest(child.key)('POST', 'operations/' + operation + '/claim', { worker: 'stale' }), /403/);
    await pause(150); assert.equal((await t.get(operation)).state, 'paused');
    await assert.rejects(rest(manager.key)('POST', 'authority/fire', { target: manager.agentId }));
  });
  await test('Existing human subscription loses masked field within the 2-second target on real backend', async () => {
    const t = await tenant('subscription'), objects = await t.human.query(anyApi.objects.list, { orgId: t.orgId }), company = objects.find(o => o.key === 'company');
    const detail = await t.human.query(anyApi.objects.get, { orgId: t.orgId, objectId: company._id }), name = detail.fields.find(f => f.key === 'name'), city = detail.fields.find(f => f.key === 'city');
    const row = await t.human.mutation(anyApi.records.create, { orgId: t.orgId, objectId: company._id, values: { [name._id]: 'Synthetic title', [city._id]: 'Hidden after change' } });
    const socket = new ConvexClient(runtime.url, { logger: false }); socket.setAuth(async () => runtime.token(t.subject)); let current, error;
    const unsubscribe = socket.onUpdate(anyApi.records.get, { orgId: t.orgId, recordId: row.recordId }, value => { current = value; }, e => { error = e; });
    try {
      const deadline = Date.now() + 5000; while (!current && !error && Date.now() < deadline) await pause(20); if (error) throw error;
      assert.equal(current.record.values[city._id], 'Hidden after change');
      const members = await t.human.query(anyApi.orgs.members, { orgId: t.orgId }), member = members.find(m => m.user._id === t.userId).member;
      const start = performance.now(); await t.human.mutation(anyApi['authority/policies'].setMember, { orgId: t.orgId, memberId: member._id, hiddenFieldIds: [city._id] });
      while (current.record.values[city._id] !== undefined && performance.now() - start < 2000) await pause(10);
      const elapsedMs = performance.now() - start; assert.equal(current.record.values[city._id], undefined); assert.ok(elapsedMs < 2000);
      console.log('MEASURE subscription mask propagation ms', elapsedMs.toFixed(2));
      await assert.rejects(t.human.mutation(anyApi.records.update, { orgId: t.orgId, recordId: row.recordId, values: { [city._id]: 'denied' } }));
    } finally { unsubscribe(); await socket.close(); }
  });
}
