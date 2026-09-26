import { expect, it } from 'vitest';
import { anyApi } from 'convex/server';
import { userAndOrg } from '../../convex/test.helpers';
const connections = anyApi['integrations/connections'], bindings = anyApi['integrations/bindings'], callbacks = anyApi['integrations/callbacks'];
const hash = async (key: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)))].map(b => b.toString(16).padStart(2, '0')).join('');
async function fixture() {
  const f = await userAndOrg(); await f.t.mutation(connections.registerProvider, { provider: 'fake', enabled: true });
  const secretReferenceId = await f.t.mutation(connections.registerSecret, { orgId: f.orgId, provider: 'fake', environment: 'test', account: 'A', handle: 'vault:00000000-0000-0000-0000-000000000001' });
  const { connectionId, adapterKey } = await f.client.action(connections.connect, { orgId: f.orgId, secretReferenceId });
  const credentialHash = await hash(adapterKey);
  const provision = (logical: string, recipient: string, remove = false) => f.client.mutation(bindings.provision, { orgId: f.orgId, connectionId, logical, kind: 'recipient', recipient, remove });
  const bind = async (logical: string, recipient: string, externalId = logical) => { const intentId = await provision(logical, recipient); return f.t.mutation(bindings.bind, { credentialHash, intentId, externalId }); };
  const call = async (name: string, body: any) => { const response = await f.t.fetch(`/api/integrations/v1/${name}`, { method: 'POST', headers: { authorization: `Bearer ${adapterKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  return { ...f, connectionId, credentialHash, provision, bind, call };
}
it('authenticated callback body controls recipient-specific suppression, dedup and ordering', async () => {
  const f = await fixture(), a = await f.bind('a', 'recipient-A'), b = await f.bind('b', 'recipient-B');
  const body = JSON.stringify({ version: 2, state: 'suppressed', channel: 'email', purpose: 'marketing' });
  const args = { bindingId: a.bindingId, eventId: 'event-1', body };
  expect(await f.call('callback', args)).toMatchObject({ status: 200, body: 'applied' });
  expect(await f.call('callback', args)).toMatchObject({ status: 200, body: 'duplicate' });
  expect((await f.call('callback', { ...args, body: JSON.stringify({ version: 2, state: 'active' }) })).status).toBe(409);
  expect((await f.call('callback', { ...args, eventId: 'old', body: JSON.stringify({ version: 1, state: 'active' }) })).status).toBe(200);
  const consent = await f.t.run(ctx => ctx.db.query('consent').collect());
  expect(consent.map(c => ({ recipient: c.recipient, purpose: c.purpose, channel: c.channel, suppressed: c.suppressed }))).toEqual([{ recipient: 'recipient-A', purpose: 'marketing', channel: 'email', suppressed: true }]);
  expect((await f.call('callback', { bindingId: b.bindingId, eventId: 'event-1', body: JSON.stringify({ version: 2, state: 'suppressed', channel: 'sms', purpose: 'service' }) })).status).toBe(200);
  expect(await f.t.run(ctx => ctx.db.query('consent').collect())).toHaveLength(2);
  expect((await f.call('callback', { ...args, credentialHash: 'b'.repeat(64) })).status).toBe(200);
});
it('delete wins provisioning race and a colliding external id never changes its local recipient', async () => {
  const f = await fixture(), intentId = await f.provision('race', 'recipient-A'); await f.provision('race', 'recipient-A', true);
  expect(await f.t.mutation(bindings.bind, { credentialHash: f.credentialHash, intentId, externalId: 'late' })).toEqual({ cleanupRequired: true, bindingId: null });
  await f.bind('one', 'recipient-A', 'same'); await expect(f.bind('two', 'recipient-B', 'same')).rejects.toMatchObject({ data: { code: 'CONFLICT' } });
  const rows = await f.t.run(ctx => ctx.db.query('integrationBindings').collect()); expect(rows).toHaveLength(1); expect(rows[0].recipient).toBe('recipient-A');
});
it('partial pages retain checkpoints, reject gaps, and allow the next traversal from the durable checkpoint', async () => {
  const f = await fixture(), bound = await f.bind('page', 'recipient-A');
  const args = { credentialHash: f.credentialHash, resource: 'recipients', traversal: 'one', from: 0, page: 1, items: [{ bindingId: bound.bindingId, observation: { version: 1, state: 'active' } }], end: false, checkpoint: 10 };
  expect(await f.t.mutation(callbacks.page, args)).toBe(0);
  await expect(f.t.mutation(callbacks.page, { ...args, page: 3 })).rejects.toMatchObject({ data: { code: 'CONFLICT' } });
  expect(await f.t.mutation(callbacks.page, { ...args, page: 2, items: [], end: true })).toBe(10);
  await expect(f.t.mutation(callbacks.page, { ...args, traversal: 'two', from: 0 })).rejects.toMatchObject({ data: { code: 'CONFLICT' } });
  expect(await f.t.mutation(callbacks.page, { ...args, traversal: 'two', from: 10, checkpoint: 20, end: true })).toBe(20);
});
it('deletion after an acknowledged create disconnects its binding and cannot be reversed by replayed acknowledgements', async () => {
  const f = await fixture(), { bindingId } = await f.bind('created', 'recipient-A', 'already-created');
  await f.provision('created', 'recipient-A', true);
  expect.soft((await f.t.run(ctx => ctx.db.get(bindingId!)))?.connected).toBe(false);
  const intentId = await f.provision('created', 'recipient-A');
  expect(await f.t.mutation(bindings.bind, { credentialHash: f.credentialHash, intentId, externalId: 'already-created' })).toEqual({ cleanupRequired: true, bindingId: null });
  expect.soft((await f.t.run(ctx => ctx.db.get(bindingId!)))?.connected).toBe(false);
});
