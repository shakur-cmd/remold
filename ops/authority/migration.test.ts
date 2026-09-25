import { expect, it } from 'vitest';
import { anyApi } from 'convex/server';
import { agentFor, api, objectFields, rest, userAndOrg } from '../../convex/test.helpers';
const migration = anyApi['authority/migration'];
async function legacy(role: 'member' | 'admin' = 'member', grants = [{ action: 'create' as const, objectKey: '*' }]) {
  const f = await userAndOrg(); const agent = await agentFor(f.client, f.orgId, { name: 'old-client', role, grants });
  await f.t.run(ctx => ctx.db.patch(agent.agentId, { authorityVersion: undefined, readObjectIds: undefined, grants }));
  return { ...f, agent, call: rest(f.t, agent.key) };
}

it('freeze/create/migrate is idempotent and excludes later objects before and after migration', async () => {
  const f = await legacy(); const first = await f.t.mutation(migration.freeze, { orgId: f.orgId });
  const newId = await f.client.mutation(api.objects.create, { orgId: f.orgId, key: 'future', label: 'Future', labelPlural: 'Futures' });
  const detail = await f.client.query(api.objects.get, { orgId: f.orgId, objectId: newId });
  const row = await f.client.mutation(api.records.create, { orgId: f.orgId, objectId: newId, values: { [detail.fields[0]!._id]: 'Invisible Future' } });
  for (const migrated of [false, true]) {
    if (migrated) await f.t.mutation(migration.migrateAgent, { agentId: f.agent.agentId });
    expect((await f.call('POST', '/api/v1/changes', { action: 'create', object: 'future', values: { name: 'No' }, reason: 'future' })).status).toBe(403);
    expect((await f.call('POST', '/api/v1/suggestions', { action: 'create', object: 'future', values: { name: 'No' }, reason: 'future' })).status).toBe(404);
    expect((await f.call('GET', '/api/v1/records?object=future')).status).toBe(404);
    expect((await f.call('GET', `/api/v1/records/${row.recordId}`)).status).toBe(404);
    expect((await f.call('GET', '/api/v1/objects')).json.some((o: any) => o.key === 'future')).toBe(false);
    expect((await f.call('GET', '/api/v1/search?q=Invisible')).json).toEqual([]);
  }
  expect(await f.t.mutation(migration.freeze, { orgId: f.orgId })).toBe(first);
  expect((await f.t.mutation(migration.migrateAgent, { agentId: f.agent.agentId })).changed).toBe(false);
  const stored = await f.t.run(ctx => ctx.db.get(f.agent.agentId));
  expect(stored!.readObjectIds).not.toContain(newId);
  expect(stored!.grants.some(g => g.objectKey === '*')).toBe(false);
});

it('an unfrozen legacy agent fails closed while migrated agents continue', async () => {
  const f = await legacy(); const migrated = await agentFor(f.client, f.orgId, { name: 'new' });
  await f.t.run(ctx => ctx.db.patch(f.orgId, { authorityFrozenAt: undefined }));
  for (const [method, route, body] of [['GET', '/api/v1/objects', undefined], ['POST', '/api/v1/changes', { action: 'create', object: 'company', values: { name: 'No' }, reason: 'hold' }]] as const) {
    const response = await f.call(method, route, body); expect(response.status).toBe(503); expect(response.json.error.code).toBe('AUTHORITY_MIGRATING');
  }
  expect((await rest(f.t, migrated.key)('GET', '/api/v1/objects')).status).toBe(200);
});

it('dangling legacy grants are dropped and cannot attach to a later key', async () => {
  const f = await legacy('member', [{ action: 'create', objectKey: 'invoice' }]);
  expect((await f.t.mutation(migration.migrateAgent, { agentId: f.agent.agentId })).dropped).toEqual(['create:invoice']);
  await f.client.mutation(api.objects.create, { orgId: f.orgId, key: 'invoice', label: 'Invoice', labelPlural: 'Invoices' });
  expect((await f.call('POST', '/api/v1/changes', { action: 'create', object: 'invoice', values: { name: 'No' }, reason: 'latent grant' })).status).toBe(403);
});

it('admin legacy role adds no authority, and object key reuse never transfers object-ID grants', async () => {
  for (const role of ['member', 'admin'] as const) {
    const f = await legacy(role, [{ action: 'create', objectKey: 'company' }]);
    await f.t.mutation(migration.migrateAgent, { agentId: f.agent.agentId });
    const company = await objectFields(f.client, f.orgId, 'company');
    await f.t.run(ctx => ctx.db.patch(company.object._id, { key: 'archivedCompany' }));
    await f.client.mutation(api.objects.create, { orgId: f.orgId, key: 'company', label: 'Replacement', labelPlural: 'Replacements' });
    expect((await f.call('POST', '/api/v1/changes', { action: 'create', object: 'company', values: { name: 'No' }, reason: 'reused key' })).status).toBe(403);
    expect((await f.call('GET', '/api/v1/records?object=company')).status).toBe(404);
    expect((await f.call('POST', '/api/v1/changes', { action: 'create', object: 'archivedCompany', values: { name: 'Still authorized' }, reason: 'original ID' })).status).toBe(200);
  }
});

it('future required fields on existing objects preserve legacy authorized writes', async () => {
  const f = await legacy(); await f.t.mutation(migration.migrateAgent, { agentId: f.agent.agentId });
  const company = await objectFields(f.client, f.orgId, 'company');
  await f.client.mutation(api.fields.create, { orgId: f.orgId, objectId: company.object._id, key: 'later', label: 'Later required', type: 'text', required: true });
  expect((await f.call('POST', '/api/v1/changes', { action: 'create', object: 'company', values: { name: 'Allowed', later: 'New field' }, reason: 'compatible' })).status).toBe(200);
});

it('a human explicitly adopts a fired suggestion as a new attributable action', async () => {
  const f = await userAndOrg(); const agent = await agentFor(f.client, f.orgId, { name: 'fired' });
  const proposed = await rest(f.t, agent.key)('POST', '/api/v1/suggestions', { action: 'create', object: 'company', values: { name: 'Adopt me' }, reason: 'original author' });
  await f.client.mutation(api.agents.revoke, { orgId: f.orgId, agentId: agent.agentId });
  const adopted = await f.client.mutation(api.suggestions.adopt, { orgId: f.orgId, suggestionId: proposed.json.suggestion.id });
  const applied = await f.client.mutation(api.suggestions.apply, { orgId: f.orgId, suggestionId: adopted });
  expect(applied.status).toBe('applied');
  const data = await f.t.run(async ctx => ({ event: await ctx.db.get(applied.eventId!), adopted: await ctx.db.get(adopted), old: await ctx.db.get(proposed.json.suggestion.id) }));
  expect(data.event!.actor.kind).toBe('user'); expect(data.adopted!.agentId).toBe(agent.agentId); expect(data.adopted!.adoptedFrom).toBe(proposed.json.suggestion.id); expect((data.old as any).status).toBe('pending');
});

it('an explicit legacy grant stays on the object that had its key at freeze, even after an operator rename (IV D7)', async () => {
  // Legacy agent holds update:vendor; no vendor object existed when authority was frozen.
  const f = await legacy('member', [{ action: 'update' as const, objectKey: 'vendor' }]);
  await f.t.mutation(migration.freeze, { orgId: f.orgId });
  const campaign = await objectFields(f.client, f.orgId, 'campaign');
  const row = await f.client.mutation(api.records.create, { orgId: f.orgId, objectId: campaign.object._id, values: { [campaign.fields.name._id]: 'Launch' } });
  // Operator-only rename (no public rename exists) of a pre-freeze object onto the granted key.
  await f.t.run(ctx => ctx.db.patch(campaign.object._id, { key: 'vendor' }));
  const update = () => f.call('POST', '/api/v1/changes', { action: 'update', record: row.recordId, values: { name: 'Hijacked' }, reason: 'rename' });
  expect((await update()).status).toBe(403);
  const migrated = await f.t.mutation(migration.migrateAgent, { agentId: f.agent.agentId });
  expect(migrated.dropped).toEqual(['update:vendor']);
  expect((await update()).status).toBe(403);
});
