import assert from 'node:assert/strict';
import { anyApi } from 'convex/server';
import { commands } from './service-fixture.mjs';
export async function replayAuthorityBoundaries({ runtime, tenant, test }) {
  const call = key => async (method, path, body) => { const r = await fetch(runtime.site + '/api/v1/' + path, { method, headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const value = await r.json(); if (!r.ok) throw new Error(r.status + ':' + JSON.stringify(value)); return value; };
  const grant = (t, target, capability, scope, mode = 'direct') => t.human.mutation(anyApi['authority/grants'].grant, { orgId: t.orgId, target, capability, scope, mode, delegate: false, expiresAt: Date.now() + 60000 });
  await test('Propose-mode external authority still requires human approval; currency and binding scopes cannot widen', async () => {
    const t = await tenant('propose-mode'), other = await tenant('foreign-scope'), agent = await t.human.action(anyApi.agents.createScoped, { orgId: t.orgId, name: 'bounded', origin: 'external' }), api = call(agent.key);
    await grant(t, agent.agentId, 'model.call', { kind: 'model', maxUnitsPerRun: 5, maxSteps: 2 }, 'propose');
    const id = await api('POST', 'operations', { logical: 'human-needed', bindingId: t.bindingId, capability: 'model.call', payload: t.payload, reservationUnits: 5, maxSteps: 2 });
    await assert.rejects(api('POST', 'operations/' + id + '/claim', { worker: 'w' }), /Approval/);
    await t.human.mutation(commands.approve, { orgId: t.orgId, id, expiresAt: Date.now() + 60000 });
    await api('POST', 'operations/' + id + '/claim', { worker: 'w' }); await t.cancel(id);
    const scope = { kind: 'bindings', bindings: [t.bindingId], currency: 'USD', maxAmountMinor: 5, maxRecipients: 1 };
    await assert.rejects(grant(t, agent.agentId, 'social.publish', { ...scope, bindings: [other.bindingId] }));
    await grant(t, agent.agentId, 'social.publish', scope);
    for (const patch of [{ currency: 'EUR' }, { amountMinor: 6 }, { audience: ['A', 'B'] }]) await assert.rejects(api('POST', 'operations', { logical: JSON.stringify(patch), bindingId: t.bindingId, capability: 'social.publish', payload: { ...t.payload, ...patch }, reservationUnits: 1, maxSteps: 1 }), /capability/);
  });
  await test('Every approval material field invalidates the reviewed version', async () => {
    const t = await tenant('material-fields');
    for (const [key, value] of Object.entries({ audience: ['new'], audienceVersion: 2, amountMinor: 1, currency: 'EUR', workflowVersion: 2, content: 'new', schedule: 1 })) {
      const id = await t.propose(key, 1, 1); await t.human.mutation(commands.editHuman, { orgId: t.orgId, id, payload: { ...t.payload, [key]: value } });
      await assert.rejects(t.claim(id), /Approval/);
    }
  });
  await test('Actual human approver role downgrade invalidates already-approved dispatch', async () => {
    const t = await tenant('approver-role'), admin = runtime.client('approver-' + t.orgId), adminId = await admin.mutation(anyApi.users.store, {});
    const invite = await t.human.mutation(anyApi.invites.create, { orgId: t.orgId, role: 'admin' }); await admin.mutation(anyApi.invites.accept, { token: invite.token });
    const id = await t.propose('approved', 1, 1); await admin.mutation(commands.approve, { orgId: t.orgId, id, expiresAt: Date.now() + 60000 });
    const claimed = await t.claim(id); await t.human.mutation(anyApi.orgs.setRole, { orgId: t.orgId, userId: adminId, role: 'member' });
    await assert.rejects(t.adapter('permit', { id, ...claimed, worker: 'worker' }), /approval|authority|claim/i); await t.cancel(id);
  });
  await test('Final permit rechecks missing usage discovered after a different operation was claimed', async () => {
    const t = await tenant('final-missing'), one = await t.propose('first', 4, 1), two = await t.propose('second', 3, 1), c = await t.claim(two), sent = await t.start(one);
    await t.adapter('reconcile', { ...sent, providerRef: 'usage-unknown' });
    await assert.rejects(t.adapter('permit', { id: two, ...c, worker: 'worker' }), /usage|budget/i);
    await t.adapter('reconcile', { ...sent, providerRef: 'usage-unknown', usage: 1 }); await t.cancel(two);
  });
  await test('Human adoption creates a new attributed command while preserving the fired agent original', async () => {
    const t = await tenant('adoption'), agent = await t.human.action(anyApi.agents.createScoped, { orgId: t.orgId, name: 'author', origin: 'external' });
    await grant(t, agent.agentId, 'model.call', { kind: 'model', maxUnitsPerRun: 5, maxSteps: 1 });
    const id = await call(agent.key)('POST', 'operations', { logical: 'original', bindingId: t.bindingId, capability: 'model.call', payload: t.payload, reservationUnits: 5, maxSteps: 1 });
    await t.human.mutation(anyApi.agents.revoke, { orgId: t.orgId, agentId: agent.agentId });
    const adopted = await t.human.mutation(commands.adopt, { orgId: t.orgId, id, logical: 'human-copy' });
    assert.notEqual(adopted, id); const original = await t.get(id), copy = await t.get(adopted);
    assert.equal(original.actor.kind, 'agent'); assert.equal(copy.actor.kind, 'user'); assert.deepEqual(copy.author, original.author); assert.equal(copy.adoptedFrom, id);
    await t.human.mutation(commands.approve, { orgId: t.orgId, id: adopted, expiresAt: Date.now() + 60000 }); await t.claim(adopted); await t.cancel(adopted);
  });
}
