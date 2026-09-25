import { expect, it } from 'vitest';
import { agentFor, api, objectFields, rest, userAndOrg } from '../../convex/test.helpers';

it('an existing wildcard does not authorize writes to a future object', async () => {
  const { t, client, orgId } = await userAndOrg();
  const agent = await agentFor(client, orgId, { name: 'legacy', grants: [{ action: 'create', objectKey: '*' }] });
  const call = rest(t, agent.key);
  expect((await call('POST', '/api/v1/changes', { action: 'create', object: 'company', values: { name: 'Allowed' }, reason: 'existing domain' })).status).toBe(200);
  await client.mutation(api.objects.create, { orgId, key: 'future', label: 'Future', labelPlural: 'Future objects' });
  expect((await call('POST', '/api/v1/changes', { action: 'create', object: 'future', values: { name: 'Denied' }, reason: 'future domain' })).status).toBe(403);
});

it('readonly stops a human record mutation at the shared write boundary', async () => {
  const { t, client, orgId } = await userAndOrg();
  const company = await objectFields(client, orgId, 'company');
  await t.run(ctx => ctx.db.patch(orgId, { flags: { readonly: true } }));
  await expect(client.mutation(api.records.create, { orgId, objectId: company.object._id, values: { [company.fields.name._id]: 'Denied' } })).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
});

it('firing an agent pauses its suggestion instead of applying stale authority', async () => {
  const { t, client, orgId } = await userAndOrg();
  const agent = await agentFor(client, orgId, { name: 'retiring' });
  const proposal = await rest(t, agent.key)('POST', '/api/v1/suggestions', { action: 'create', object: 'company', values: { name: 'Paused' }, reason: 'review' });
  await client.mutation(api.agents.revoke, { orgId, agentId: agent.agentId });
  await expect(client.mutation(api.suggestions.apply, { orgId, suggestionId: proposal.json.suggestion.id })).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
});
