import { anyApi } from 'convex/server';
import { randomUUID } from 'node:crypto';
export const commands = anyApi['integrations/commands'];
export async function tenant(runtime, label, limits = {}) {
  const name = label + '-' + randomUUID(), human = runtime.client(name);
  const userId = await human.mutation(anyApi.users.store, {}), orgId = await human.mutation(anyApi.orgs.create, { name });
  runtime.run('integrations/budgets:configure', { orgId, cap: 10, maxConcurrent: 3, maxPerRun: 8, maxSteps: 3, maxRecipients: 10, ...limits });
  const account = 'account-' + name;
  const secretReferenceId = runtime.run('integrations/connections:registerSecret', { orgId, provider: 'fake', environment: 'test', account, handle: 'vault:' + randomUUID() });
  const { connectionId, adapterKey } = await human.action(anyApi['integrations/connections'].connect, { orgId, secretReferenceId });
  const adapter = async (name, body) => {
    const response = await fetch(runtime.site + '/api/integrations/v1/' + name, { method: 'POST', headers: { authorization: 'Bearer ' + adapterKey, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json(); if (!response.ok) throw new Error(response.status + ':' + JSON.stringify(result)); return result;
  };
  const intentId = await human.mutation(anyApi['integrations/bindings'].provision, { orgId, connectionId, logical: 'model', kind: 'model', remove: false });
  const { bindingId } = await adapter('bind', { intentId, externalId: 'same-external-id' });
  const payload = { content: 'synthetic', audience: [], audienceVersion: 1, destination: account, schedule: 0, amountMinor: 0, currency: 'USD', workflowVersion: 1 };
  const propose = async (logical, reservationUnits = 5, maxSteps = 2, extra = {}) => {
    const id = await human.mutation(commands.proposeHuman, { orgId, logical, bindingId, capability: 'model.call', payload, reservationUnits, maxSteps, ...extra });
    await human.mutation(commands.approve, { orgId, id, expiresAt: Date.now() + 60000 }); return id;
  };
  const claim = id => human.mutation(commands.claimHuman, { orgId, id, worker: 'worker' });
  const permit = async id => { const c = await claim(id); return adapter('permit', { id, ...c, worker: 'worker' }); };
  const consume = p => { const { expires, maxUnits, maxRecipients, ...args } = p; return adapter('consume', args); };
  const start = async id => { const p = await permit(id); await consume(p); return { id, fence: p.fence, step: p.step }; };
  const get = id => human.query(commands.getHuman, { orgId, id });
  const dump = () => runtime.run('authorityFixture:dump', { orgId });
  const budget = () => dump().budgets.find(b => b.key === orgId);
  const cancel = id => human.mutation(commands.cancelHuman, { orgId, id });
  return { subject: name, human, orgId, userId, account, connectionId, secretReferenceId, adapterKey, bindingId, adapter, payload, propose, claim, permit, consume, start, get, dump, budget, cancel };
}
export async function financial(t, kind = 'payment', paidMinor = 10) {
  const identity = { bindingId: t.bindingId, documentRef: 'synthetic-document', providerRef: 'synthetic-provider-source', kind, currency: 'USD', paidMinor };
  let cancelled = false;
  const pull = async (receipts = [], complete = true) => {
    const started = await t.adapter('safety-begin', identity);
    for (const receipt of receipts) await t.adapter('safety-receipt', { ...started, receipt });
    if (!complete) return started;
    const resource = `financial:${started.targetId}:${started.generation}`;
    await t.adapter('page', { resource, traversal: 'generation-' + started.generation, from: 0, page: 1, items: [], end: true, checkpoint: started.generation });
    const lookupId = await t.adapter('lookup', { resource });
    if (kind === 'clientRecurring' && receipts.some(r => r.status === 'succeeded')) cancelled = true;
    await t.adapter('safety-complete', { ...started, paidMinor, cancelled, lookupId });
    return { ...started, lookupId };
  };
  const { targetId } = await pull();
  const receipt = (id, receiptId, amountMinor, status = 'succeeded') => pull([{ receiptId, operationId: id, sourceRef: identity.providerRef, currency: identity.currency, amountMinor, status }]);
  return { targetId, pull, receipt, identity };
}
