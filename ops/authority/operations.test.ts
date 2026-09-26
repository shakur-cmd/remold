import { expect, it } from 'vitest';
import { anyApi } from 'convex/server';
import { api, userAndOrg } from '../../convex/test.helpers';
const commands = anyApi['integrations/commands'], dispatch = anyApi['integrations/dispatch'], outcomes = anyApi['integrations/outcomes'];
const hash = async (key: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)))].map(b => b.toString(16).padStart(2, '0')).join('');
async function fixture() {
  const f = await userAndOrg(), credentialHash = 'a'.repeat(64);
  await f.t.mutation(anyApi['integrations/connections'].registerProvider, { provider: 'fake', enabled: true });
  const secretReferenceId = await f.t.mutation(anyApi['integrations/connections'].registerSecret, { orgId: f.orgId, provider: 'fake', environment: 'test', account: 'account-A', handle: 'vault:00000000-0000-0000-0000-000000000001' });
  const connectionId = await f.client.mutation(anyApi['integrations/connections'].insert, { orgId: f.orgId, secretReferenceId, credentialHash });
  const bindingId = await f.t.run(ctx => ctx.db.insert('integrationBindings', { orgId: f.orgId, connectionId, provider: 'fake', environment: 'test', account: 'account-A', kind: 'model', externalId: 'model-A', connected: true }));
  for (const orgId of [undefined, f.orgId]) await f.t.mutation(anyApi['integrations/budgets'].configure, { ...(orgId ? { orgId } : {}), cap: 10, maxConcurrent: 3, maxPerRun: 10, maxSteps: 5, maxRecipients: 10 });
  const payload = { content: 'bounded synthetic prompt', audience: [], audienceVersion: 1, destination: 'account-A', schedule: 0, amountMinor: 0, currency: 'USD', workflowVersion: 1 };
  const propose = async (logical: string, units = 5, steps = 2) => { const id = await f.client.mutation(commands.proposeHuman, { orgId: f.orgId, logical, bindingId, capability: 'model.call', payload, reservationUnits: units, maxSteps: steps }); await f.client.mutation(commands.approve, { orgId: f.orgId, id, expiresAt: Date.now() + 60000 }); return id; };
  const claim = (id: any) => f.client.mutation(commands.claimHuman, { orgId: f.orgId, id, worker: 'worker-A' });
  const start = async (id: any) => { const claimed = await claim(id), target = { credentialHash, id, ...claimed }; const permit = await f.t.mutation(dispatch.permit, { ...target, worker: 'worker-A' }); await f.t.mutation(dispatch.consume, { ...target, worker: 'worker-A', version: permit.version, bindingId }); return target; };
  const budget = () => f.t.run(ctx => ctx.db.query('usageBudgets').withIndex('by_key', q => q.eq('key', f.orgId)).unique());
  return { ...f, credentialHash, bindingId, payload, propose, claim, start, budget };
}
it('an ungranted scoped agent cannot submit an external proposal', async () => {
  const f = await fixture(), agent = await f.client.action(api.agents.createScoped, { orgId: f.orgId, name: 'ungranted', origin: 'external' });
  await expect(f.t.mutation(commands.proposeAgent, { keyHash: await hash(agent.key), logical: 'denied', bindingId: f.bindingId, capability: 'model.call', payload: f.payload, reservationUnits: 5, maxSteps: 2 })).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
});
it('cancelled consumed work retains unknown cost, refuses new dispatch, and records late cost once', async () => {
  const f = await fixture(), id = await f.propose('cancel'), target = await f.start(id);
  await f.client.mutation(commands.cancelHuman, { orgId: f.orgId, id });
  await f.t.mutation(outcomes.fail, { ...target, retryable: true });
  expect(await f.budget()).toMatchObject({ reserved: 5, active: 1 });
  await expect(f.claim(id)).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
  expect(await f.t.mutation(outcomes.reconcile, { ...target, providerRef: 'accepted', usage: 2, continue: true })).toMatchObject({ accepted: true, late: true, continuationRefused: true });
  await f.t.mutation(outcomes.reconcile, { ...target, providerRef: 'accepted', usage: 2 });
  expect(await f.budget()).toMatchObject({ reserved: 0, active: 0, spent: 2 });
});
it('settled old-step absence cannot release the current unknown step', async () => {
  const f = await fixture(), id = await f.propose('steps'), first = await f.start(id);
  await f.t.mutation(outcomes.reconcile, { ...first, providerRef: 'step1', usage: 1, continue: true });
  const second = await f.start(id); await f.t.mutation(outcomes.unknown, second);
  for (const finality of ['provisional', 'final']) await expect(f.client.mutation(outcomes.operatorResolveUnknown, { orgId: f.orgId, id, fence: first.fence, step: first.step, finality, evidence: 'synthetic check' })).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
  expect(await f.budget()).toMatchObject({ reserved: 4, active: 1, spent: 1 });
  await f.client.mutation(outcomes.operatorResolveUnknown, { orgId: f.orgId, id, fence: second.fence, step: second.step, finality: 'final', evidence: 'operator confirmed synthetic absence' });
  expect(await f.budget()).toMatchObject({ reserved: 0, active: 0, spent: 1 });
});
it('missing usage blocks cheaper new work and authoritative usage settles exactly once', async () => {
  const f = await fixture(), id = await f.propose('missing', 6, 1), target = await f.start(id);
  await f.t.mutation(outcomes.reconcile, { ...target, providerRef: 'missing' });
  const cheap = await f.propose('cheap', 1, 1); await expect(f.claim(cheap)).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
  expect(await f.budget()).toMatchObject({ reserved: 6, active: 1, missingUsage: true });
  await f.t.mutation(outcomes.reconcile, { ...target, providerRef: 'missing', usage: 2 }); await f.claim(cheap);
  expect(await f.budget()).toMatchObject({ reserved: 1, active: 1, spent: 2, missingUsage: false });
});
it('provider finality defaults denied and operator override preserves unexpected late truth', async () => {
  const f = await fixture(), id = await f.propose('absence'), target = await f.start(id); await f.t.mutation(outcomes.unknown, target);
  await expect(f.t.mutation(outcomes.resolveUnknown, { ...target, finality: 'final', evidence: 'unproven reference' })).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
  await f.client.mutation(outcomes.operatorResolveUnknown, { orgId: f.orgId, id, fence: target.fence, step: target.step, finality: 'final', evidence: 'owner accepted final absence risk' });
  await f.t.mutation(outcomes.reconcile, { ...target, providerRef: 'late', usage: 3 }); await f.t.mutation(outcomes.reconcile, { ...target, providerRef: 'late', usage: 3 });
  expect(await f.budget()).toMatchObject({ reserved: 0, active: 0, spent: 3, anomaly: 'acceptedAfterFinalAbsence' });
});
it('removing and rejoining a human does not revive the prior approval or operation', async () => {
  const f = await fixture(), id = await f.propose('membership-generation');
  await f.t.run(async ctx => { const old = await ctx.db.query('members').withIndex('by_org_user', q => q.eq('orgId', f.orgId)).first(); if (!old) throw Error('missing member'); await ctx.db.delete(old._id); await ctx.db.insert('members', { orgId: old.orgId, userId: old.userId, role: old.role }); });
  await expect(f.claim(id)).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
});
it('an authority sweep preserves an unrelated valid proposal awaiting approval', async () => {
  const f = await fixture();
  const id = await f.client.mutation(commands.proposeHuman, { orgId: f.orgId, logical: 'waiting', bindingId: f.bindingId, capability: 'model.call', payload: f.payload, reservationUnits: 5, maxSteps: 2 });
  await f.t.mutation(anyApi['integrations/lifecycle'].sweep, { orgId: f.orgId, cursor: null });
  expect((await f.client.query(commands.getHuman, { orgId: f.orgId, id })).state).toBe('proposed');
});
