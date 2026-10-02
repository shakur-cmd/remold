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
it('the record timeline and history pages keep hidden fields hidden', async () => {
  const { t, client, orgId } = await userAndOrg();
  const [company, note, activity] = await Promise.all(['company', 'note', 'activity'].map(key => objectFields(client, orgId, key)));
  const { recordId } = await client.mutation(api.records.create, { orgId, objectId: company.object._id, values: { [company.fields.name._id]: 'Acme', [company.fields.city._id]: 'Hidden City' } });
  await client.mutation(api.records.create, { orgId, objectId: note.object._id, values: { [note.fields.body._id]: 'Secret Note', [note.fields.about._id]: recordId } });
  await client.mutation(api.records.create, { orgId, objectId: activity.object._id, values: { [activity.fields.title._id]: 'Secret Call', [activity.fields.source._id]: 'Secret Source', [activity.fields.about._id]: recordId } });
  const before = JSON.stringify(await client.query(api.events.timeline, { orgId, recordId, paginationOpts: { cursor: null, numItems: 50 } }));
  expect(before).toMatch(/Secret Note/); expect(before).toMatch(/Secret Call/);
  const agent = await agentFor(client, orgId, { name: 'reader' });
  await client.mutation(anyApi['authority/policies'].setAgentMasks, { orgId, agentId: agent.agentId, hiddenFieldIds: [company.fields.city._id] });
  const memberId = await t.run(async ctx => (await ctx.db.query('members').collect())[0]!._id);
  await client.mutation(anyApi['authority/policies'].setMember, { orgId, memberId, hiddenFieldIds: [company.fields.city._id, note.fields.body._id, activity.fields.title._id, activity.fields.source._id] });
  expect.soft(JSON.stringify(await client.query(api.events.timeline, { orgId, recordId, paginationOpts: { cursor: null, numItems: 50 } }))).not.toMatch(/Secret|Hidden City/);
  const page = await rest(t, agent.key)('GET', `/api/v1/records/${recordId}/events`);
  expect(page.status).toBe(200); expect(JSON.stringify(page.json)).not.toMatch(/Hidden City/);
});
it('the calendar range keeps hidden fields hidden and serves a record-scoped reader only their records', async () => {
  const { t, client, orgId } = await userAndOrg();
  const post = await objectFields(client, orgId, 'post'), day = Date.UTC(2026, 9, 5);
  const make = async (title: string, text: string) => (await client.mutation(api.records.create, { orgId, objectId: post.object._id, values: { [post.fields.title._id]: title, [post.fields.text._id]: text, [post.fields.planned._id]: day } })).recordId;
  const mine = await make('Visible reel', 'Secret Text'); await make('Other Secret Post', 'more');
  const range = { orgId, objectId: post.object._id, fieldId: post.fields.planned._id, firstDay: day, lastDay: day, start: day, end: day + 86400000 - 1, paginationOpts: { cursor: null, numItems: 500 } };
  expect(JSON.stringify(await client.query(api.records.inRange, range))).toMatch(/Secret Text/);
  const memberId = await t.run(async ctx => (await ctx.db.query('members').collect())[0]!._id);
  await client.mutation(anyApi['authority/policies'].setMember, { orgId, memberId, scopes: [{ objectId: post.object._id, records: [mine], fields: 'all' }], hiddenFieldIds: [post.fields.text._id] });
  const scoped = await client.query(api.records.inRange, range);
  expect(scoped.page.map((r: any) => r._id)).toEqual([mine]);
  expect.soft(JSON.stringify(scoped)).not.toMatch(/Secret/);
  // A reader who cannot see the date field cannot place records by it.
  const b = await userAndOrg('B'), bPost = await objectFields(b.client, b.orgId, 'post');
  const bMember = await b.t.run(async ctx => (await ctx.db.query('members').collect())[0]!._id);
  await b.client.mutation(anyApi['authority/policies'].setMember, { orgId: b.orgId, memberId: bMember, hiddenFieldIds: [bPost.fields.planned._id] });
  await expect(b.client.query(api.records.inRange, { orgId: b.orgId, objectId: bPost.object._id, fieldId: bPost.fields.planned._id, firstDay: day, lastDay: day, start: day, end: day + 86400000 - 1, paginationOpts: { cursor: null, numItems: 500 } })).rejects.toMatchObject({ data: { code: 'NOT_FOUND' } });
});
it('later pages of the posts on Today keep hidden fields hidden and serve a record-scoped reader only their records', async () => {
  const { t, client, orgId } = await userAndOrg();
  const post = await objectFields(client, orgId, 'post'), day = { today: Date.UTC(2026, 9, 5), start: Date.UTC(2026, 9, 5, 4), end: Date.UTC(2026, 9, 6, 4) - 1 };
  const ids = [];
  for (let i = 0; i < 55; i++) ids.push((await client.mutation(api.records.create, { orgId, objectId: post.object._id, values: { [post.fields.title._id]: `Post ${i}`, [post.fields.text._id]: 'Secret Text', [post.fields.planned._id]: Date.UTC(2026, 9, 5, 12) + i } })).recordId);
  const mine = ids.slice(0, 52);
  const memberId = await t.run(async ctx => (await ctx.db.query('members').collect())[0]!._id);
  await client.mutation(anyApi['authority/policies'].setMember, { orgId, memberId, scopes: [{ objectId: post.object._id, records: mine, fields: 'all' }], hiddenFieldIds: [post.fields.text._id] });
  const first = await client.query(api.today.posts, { orgId, ...day, paginationOpts: { cursor: null, numItems: 50 } });
  expect(first.isDone).toBe(false);
  const rest = await client.query(api.today.posts, { orgId, ...day, paginationOpts: { cursor: first.continueCursor, numItems: 50 } });
  expect(rest.isDone).toBe(true);
  expect([...first.page, ...rest.page].map((r: any) => r._id).sort()).toEqual([...mine].sort());
  expect.soft(JSON.stringify([first, rest])).not.toMatch(/Secret/);
});
