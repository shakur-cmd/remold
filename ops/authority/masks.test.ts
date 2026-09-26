import { expect, it } from 'vitest';
import { anyApi } from 'convex/server';
import { agentFor, api, objectFields, rest, userAndOrg } from '../../convex/test.helpers';

it('a hidden field is removed from user records, history, suggestions and exports', async () => {
  const { t, client, orgId } = await userAndOrg();
  const company = await objectFields(client, orgId, 'company');
  const { recordId } = await client.mutation(api.records.create, { orgId, objectId: company.object._id, values: { [company.fields.name._id]: 'Private Title', [company.fields.city._id]: 'Hidden City' } });
  const agent = await agentFor(client, orgId, { name: 'writer' });
  await rest(t, agent.key)('POST', '/api/v1/suggestions', { action: 'update', record: recordId, values: { city: 'Future Secret' }, reason: 'Hidden City in free text' });
  const memberId = await t.run(async ctx => (await ctx.db.query('members').collect())[0]!._id);
  await client.mutation(anyApi['authority/policies'].setMember, { orgId, memberId, hiddenFieldIds: [company.fields.name._id, company.fields.city._id] });
  const record = await client.query(api.records.get, { orgId, recordId });
  expect.soft(JSON.stringify(record)).not.toMatch(/Private Title|Hidden City/);
  expect.soft(JSON.stringify(await client.query(api.events.forRecord, { orgId, recordId }))).not.toMatch(/Private Title|Hidden City/);
  expect.soft(JSON.stringify(await client.query(api.suggestions.list, { orgId }))).not.toMatch(/Hidden City|Future Secret/);
  expect.soft(JSON.stringify(await client.query(api.csv.exportPage, { orgId, objectId: company.object._id, cursor: null }))).not.toMatch(/Private Title|Hidden City/);
  expect(await client.query(api.records.search, { orgId, text: 'Private' })).toEqual([]);
  await expect(client.query(api.records.list, { orgId, objectId: company.object._id, filter: { fieldId: company.fields.city._id, value: 'Hidden City' }, paginationOpts: { cursor: null, numItems: 10 } })).rejects.toMatchObject({ data: { code: 'NOT_FOUND' } });
});

it('the same masks cover legacy REST/MCP reads, proposals, changes and lookup titles', async () => {
  const { t, client, orgId } = await userAndOrg();
  const company = await objectFields(client, orgId, 'company'), person = await objectFields(client, orgId, 'person');
  const { recordId } = await client.mutation(api.records.create, { orgId, objectId: company.object._id, values: { [company.fields.name._id]: 'SecretName', [company.fields.city._id]: 'SecretCity' } });
  const contact = await client.mutation(api.records.create, { orgId, objectId: person.object._id, values: { [person.fields.name._id]: 'PublicName', [person.fields.company._id]: recordId } });
  const agent = await agentFor(client, orgId, { name: 'legacy', grants: [{ action: 'update', objectKey: '*' }] }), call = rest(t, agent.key);
  await client.mutation(anyApi['authority/policies'].setAgentMasks, { orgId, agentId: agent.agentId, hiddenFieldIds: [company.fields.name._id, company.fields.city._id] });
  for (const route of [`/api/v1/records/${recordId}`, `/api/v1/records/${contact.recordId}`, '/api/v1/records?object=company', '/api/v1/search?q=SecretName']) expect.soft(JSON.stringify((await call('GET', route)).json)).not.toMatch(/SecretName|SecretCity/);
  expect((await call('POST', '/api/v1/suggestions', { action: 'update', record: recordId, values: { city: 'write' }, reason: 'masked' })).status).toBe(400);
  expect((await call('POST', '/api/v1/changes', { action: 'update', record: recordId, values: { city: 'write' }, reason: 'masked' })).status).toBe(400);
  expect((await call('GET', '/api/v1/records?object=company&filter=city&value=SecretCity')).status).toBe(404);
});
it('record-bounded human scope cannot create outside it or delete hidden fields', async () => {
  const f = await userAndOrg(), company = await objectFields(f.client, f.orgId, 'company');
  const record = await f.client.mutation(api.records.create, { orgId: f.orgId, objectId: company.object._id, values: { [company.fields.name._id]: 'Allowed', [company.fields.city._id]: 'Private' } });
  const memberId = await f.t.run(async ctx => (await ctx.db.query('members').collect())[0]._id);
  await f.client.mutation(anyApi['authority/policies'].setMember, { orgId: f.orgId, memberId, scopes: [{ objectId: company.object._id, records: [record.recordId], fields: 'all' }], hiddenFieldIds: [company.fields.city._id] });
  await expect.soft(f.client.mutation(api.records.create, { orgId: f.orgId, objectId: company.object._id, values: { [company.fields.name._id]: 'Outside scope' } })).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
  await expect.soft(f.client.mutation(api.records.remove, { orgId: f.orgId, recordId: record.recordId })).rejects.toMatchObject({ data: { code: 'NOT_FOUND' } });
});
