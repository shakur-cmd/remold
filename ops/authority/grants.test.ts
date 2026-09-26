import { expect, it } from 'vitest';
import { anyApi } from 'convex/server';
import { api, objectFields, rest, userAndOrg } from '../../convex/test.helpers';
const grantApi = anyApi['authority/grants'];
const hash = async (key: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)))].map(b => b.toString(16).padStart(2, '0')).join('');
async function fixture() {
  const f = await userAndOrg(), company = await objectFields(f.client, f.orgId, 'company');
  const manager = await f.client.action(api.agents.createScoped, { orgId: f.orgId, name: 'manager', origin: 'external' });
  const child = await f.client.action(api.agents.createScoped, { orgId: f.orgId, name: 'child', origin: 'external' });
  const row = await f.client.mutation(api.records.create, { orgId: f.orgId, objectId: company.object._id, values: { [company.fields.name._id]: 'Visible', [company.fields.city._id]: 'Secret' } });
  const scope = { kind: 'records' as const, objectId: company.object._id, records: 'all' as const, fields: [company.fields.name._id] };
  const issue = (target: any, capability: string, customScope: any = scope, parent?: any, keyHash?: string) => (keyHash ? f.t : f.client).mutation(keyHash ? grantApi.grantAgent : grantApi.grant, { ...(keyHash ? { keyHash } : { orgId: f.orgId }), target, capability, scope: customScope, mode: 'direct', delegate: true, expiresAt: Date.now() + (keyHash ? 20000 : 60000), ...(parent ? { parent } : {}) });
  return { ...f, company, manager, child, row, scope, issue, managerHash: await hash(manager.key), childHash: await hash(child.key) };
}
it('explicit record fields govern actual agent reads and direct applyChange writes', async () => {
  const f = await fixture(), call = rest(f.t, f.manager.key);
  expect((await call('GET', `/api/v1/records/${f.row.recordId}`)).status).toBe(404);
  await f.issue(f.manager.agentId, 'read'); await f.issue(f.manager.agentId, 'record.update');
  const got = await call('GET', `/api/v1/records/${f.row.recordId}`);
  expect(got.json.record.values).toEqual({ name: 'Visible' }); expect(JSON.stringify(got.json)).not.toContain('Secret');
  expect((await call('POST', '/api/v1/changes', { action: 'update', record: f.row.recordId, values: { name: 'Changed' }, reason: 'allowed' })).status).toBe(200);
  expect((await call('POST', '/api/v1/changes', { action: 'update', record: f.row.recordId, values: { city: 'No' }, reason: 'denied' })).status).toBe(400);
});
it('delegated reads stop after manager downgrade while an independent human field grant survives', async () => {
  const f = await fixture(), parent = await f.issue(f.manager.agentId, 'read');
  await f.issue(f.manager.agentId, 'agent.manage', { kind: 'agents', agents: [f.child.agentId] });
  await f.issue(f.child.agentId, 'read', f.scope, parent, f.managerHash);
  await f.issue(f.child.agentId, 'read', { ...f.scope, fields: [f.company.fields.city._id] });
  const call = rest(f.t, f.child.key), route = `/api/v1/records/${f.row.recordId}`;
  expect((await call('GET', route)).json.record.values).toEqual({ name: 'Visible', city: 'Secret' });
  await f.client.mutation(grantApi.revoke, { orgId: f.orgId, id: parent });
  expect((await call('GET', route)).json.record.values).toEqual({ city: 'Secret' });
  expect((await call('GET', route)).json.record.title).toBe('');
});
it('a manager cannot escalate fields, manage peers, or fire its grant ancestor', async () => {
  const f = await fixture(), parent = await f.issue(f.manager.agentId, 'read');
  await f.issue(f.manager.agentId, 'agent.manage', { kind: 'agents', agents: [f.child.agentId] });
  await expect(f.issue(f.child.agentId, 'read', { ...f.scope, fields: [f.company.fields.city._id] }, parent, f.managerHash)).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
  await f.issue(f.child.agentId, 'read', f.scope, parent, f.managerHash);
  await f.issue(f.child.agentId, 'agent.manage', { kind: 'agents', agents: [f.manager.agentId] });
  await expect(f.t.mutation(grantApi.fireAgent, { keyHash: f.childHash, target: f.manager.agentId })).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
  await expect(f.t.mutation(grantApi.fireAgent, { keyHash: f.managerHash, target: f.manager.agentId })).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
});
it('a restricted human cannot widen authority through legacy agent creation, replacement, or explicit grants', async () => {
  const f = await fixture();
  const member = await f.t.run(ctx => ctx.db.query('members').withIndex('by_org_user', q => q.eq('orgId', f.orgId)).first());
  await f.client.mutation(anyApi['authority/policies'].setMember, { orgId: f.orgId, memberId: member!._id, hiddenFieldIds: [f.company.fields.city._id], scopes: [{ objectId: f.company.object._id, records: [f.row.recordId], fields: 'all' }] });
  await expect.soft(f.client.action(api.agents.create, { orgId: f.orgId, name: 'escape' })).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
  await expect.soft(f.client.mutation(api.agents.setGrants, { orgId: f.orgId, agentId: f.manager.agentId, grants: [{ action: 'update', objectKey: '*' }] })).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
  await expect.soft(f.issue(f.child.agentId, 'read', { ...f.scope, records: [f.row.recordId], fields: [f.company.fields.city._id] })).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
  await expect.soft(f.issue(f.child.agentId, 'read', f.scope)).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
  const child = await f.client.action(api.agents.createScoped, { orgId: f.orgId, name: 'bounded', origin: 'external' });
  await f.issue(child.agentId, 'read', { ...f.scope, records: [f.row.recordId] });
  expect((await rest(f.t, child.key)('GET', `/api/v1/records/${f.row.recordId}`)).json.record.values).toEqual({ name: 'Visible' });
});
it('an all-records grant is still confined to its one object', async () => {
  const f = await fixture(); await f.issue(f.manager.agentId, 'read');
  const objects = await rest(f.t, f.manager.key)('GET', '/api/v1/objects');
  expect(objects.json.map((o: any) => o.key)).toEqual(['company']);
});
