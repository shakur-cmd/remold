import { expect, it } from 'vitest';
import { anyApi } from 'convex/server';
import { api, objectFields, rest, userAndOrg } from '../../convex/test.helpers';
it('a new scoped agent sees its own inbox rows and counts, not unshared human text', async () => {
  const f = await userAndOrg(), agent = await f.client.action(api.agents.createScoped, { orgId: f.orgId, name: 'bounded', origin: 'external' }), call = rest(f.t, agent.key);
  await f.client.mutation(api.inbox.add, { orgId: f.orgId, text: 'Unshared future-object data' });
  const own = await call('POST', '/api/v1/inbox', { text: 'My own work' });
  expect.soft((await call('GET', '/api/v1/inbox')).json.map((r: any) => r.id)).toEqual([own.json.id]);
  expect.soft((await call('GET', '/api/v1/me')).json.pendingInbox).toBe(1);
});
it('an agent cannot resolve an unreadable inbox row or attach an unreadable record', async () => {
  const f = await userAndOrg(), agent = await f.client.action(api.agents.createScoped, { orgId: f.orgId, name: 'bounded', origin: 'external' }), call = rest(f.t, agent.key);
  const hidden = await f.client.mutation(api.inbox.add, { orgId: f.orgId, text: 'Not shared' });
  expect.soft((await call('POST', `/api/v1/inbox/${hidden}/resolve`, {})).status).toBe(404);
  const company = await objectFields(f.client, f.orgId, 'company'), row = await f.client.mutation(api.records.create, { orgId: f.orgId, objectId: company.object._id, values: { [company.fields.name._id]: 'Outside scope' } });
  const own = await call('POST', '/api/v1/inbox', { text: 'Own' });
  expect.soft((await call('POST', `/api/v1/inbox/${own.json.id}/resolve`, { recordId: row.recordId })).status).toBe(404);
});
it('sharing requires deliberate human choice plus a separate current agent entitlement', async () => {
  const f = await userAndOrg(), agent = await f.client.action(api.agents.create, { orgId: f.orgId, name: 'legacy reader' }), call = rest(f.t, agent.key);
  const shared = await f.client.mutation(api.inbox.add, { orgId: f.orgId, text: 'Explicit shared work', shareWithAgents: true });
  await f.client.mutation(api.inbox.add, { orgId: f.orgId, text: 'Not shared by default' });
  expect((await call('GET', '/api/v1/inbox')).json).toEqual([]);
  await f.client.mutation(api.agents.setSharedInbox, { orgId: f.orgId, agentId: agent.agentId, enabled: true });
  expect((await call('GET', '/api/v1/inbox')).json.map((r: any) => r.id)).toEqual([shared]);
  const before = await f.t.run(ctx => ctx.db.get(agent.agentId));
  await f.client.mutation(api.agents.setSharedInbox, { orgId: f.orgId, agentId: agent.agentId, enabled: false });
  const after = await f.t.run(ctx => ctx.db.get(agent.agentId));
  expect(after!.authorityEpoch).toBe(before!.authorityEpoch! + 1);
  expect((await call('GET', '/api/v1/inbox')).json).toEqual([]);
});
it('masked agents lose shared text and restricted humans cannot publish or widen shared inbox authority', async () => {
  const f = await userAndOrg(), company = await objectFields(f.client, f.orgId, 'company'), agent = await f.client.action(api.agents.create, { orgId: f.orgId, name: 'reader' }), call = rest(f.t, agent.key);
  await f.client.mutation(api.agents.setSharedInbox, { orgId: f.orgId, agentId: agent.agentId, enabled: true });
  await f.client.mutation(api.inbox.add, { orgId: f.orgId, text: 'Explicit shared work', shareWithAgents: true });
  await f.client.mutation(anyApi['authority/policies'].setAgentMasks, { orgId: f.orgId, agentId: agent.agentId, hiddenFieldIds: [company.fields.name._id] });
  expect((await call('GET', '/api/v1/inbox')).json).toEqual([]);
  const memberId = await f.t.run(async ctx => (await ctx.db.query('members').collect())[0]._id);
  await f.client.mutation(anyApi['authority/policies'].setMember, { orgId: f.orgId, memberId, scopes: [], hiddenFieldIds: [] });
  await expect(f.client.mutation(api.inbox.add, { orgId: f.orgId, text: 'Outside sharing ceiling', shareWithAgents: true })).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
  await expect(f.client.mutation(api.agents.setSharedInbox, { orgId: f.orgId, agentId: agent.agentId, enabled: true })).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
});
it('old inbox compatibility is bounded to pre-freeze agents and rows, including absent audience on rollback writes', async () => {
  const f = await userAndOrg(), agent = await f.client.action(api.agents.create, { orgId: f.orgId, name: 'old reader' }), call = rest(f.t, agent.key);
  const old = await f.client.mutation(api.inbox.add, { orgId: f.orgId, text: 'Old shared work' });
  await f.t.run(async ctx => {
    await ctx.db.patch(agent.agentId, { authorityVersion: undefined, sharedInbox: undefined });
    await ctx.db.patch(old, { audience: undefined });
    const row = (await ctx.db.get(old))!;
    await ctx.db.patch(f.orgId, { authorityFrozenAt: row._creationTime });
  });
  await f.t.run(ctx => ctx.db.insert('agentInbox', { orgId: f.orgId, text: 'Old code after freeze', source: 'rollback', from: { kind: 'user', id: 'test' }, status: 'pending' }));
  expect((await call('GET', '/api/v1/inbox')).json.map((r: any) => r.id)).toEqual([old]);
  await f.t.mutation(anyApi['authority/migration'].migrateAgent, { agentId: agent.agentId });
  expect((await call('GET', '/api/v1/inbox')).json.map((r: any) => r.id)).toEqual([old]);
});
