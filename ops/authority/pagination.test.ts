import { expect, it } from 'vitest';
import { anyApi } from 'convex/server';
import { api, objectFields, rest, userAndOrg } from '../../convex/test.helpers';

// A record-scoped caller pages their own record list, so page sizes, done flags and
// cursors depend only on rows they can read. Each test compares what the caller sees
// with and without unreadable rows, or for a value only unreadable rows hold against a
// value nobody holds (IV round 3, P).
async function world() {
  const f = await userAndOrg(), deal = await objectFields(f.client, f.orgId, 'opportunity'), company = await objectFields(f.client, f.orgId, 'company');
  const acme = (await f.client.mutation(api.records.create, { orgId: f.orgId, objectId: company.object._id, values: { [company.fields.name._id]: 'Acme' } })).recordId;
  const create = (name: string, amount: number) => f.client.mutation(api.records.create, { orgId: f.orgId, objectId: deal.object._id, values: { [deal.fields.name._id]: name, [deal.fields.amount._id]: amount, [deal.fields.company._id]: acme } }).then((r: any) => r.recordId);
  const mine = await create('Mine', 100);
  // A separate member, so the owner can keep creating rows the member cannot read.
  const member = f.t.withIdentity({ tokenIdentifier: 'clerk|member', name: 'Member' }), userId = await member.mutation(api.users.store, {});
  await member.mutation(api.invites.accept, { token: (await f.client.mutation(api.invites.create, { orgId: f.orgId, role: 'member' })).token });
  const memberId = await f.t.run(async (ctx: any) => (await ctx.db.query('members').collect()).find((m: any) => m.userId === userId)._id);
  const objects = await f.client.query(api.objects.list, { orgId: f.orgId });
  const scopes = [{ objectId: deal.object._id, records: [mine], fields: 'all' }, ...objects.filter((o: any) => o.key !== 'opportunity').map((o: any) => ({ objectId: o._id, records: 'all', fields: 'all' }))];
  const agent = await f.client.action(api.agents.createScoped, { orgId: f.orgId, name: 'pager', origin: 'external' });
  await f.client.mutation(anyApi['authority/grants'].grant, { orgId: f.orgId, target: agent.agentId, capability: 'read', scope: { kind: 'records', objectId: deal.object._id, records: [mine], fields: Object.values(deal.fields).map((x: any) => x._id) }, mode: 'direct', delegate: false, expiresAt: Date.now() + 600000 });
  const hide = async (n: number, amount = 5000) => { for (let i = 0; i < n; i++) await create('Hidden ' + i, amount); };
  const restrict = () => f.client.mutation(anyApi['authority/policies'].setMember, { orgId: f.orgId, memberId, scopes, hiddenFieldIds: [] });
  const walk = async (fn: any, args: any, numItems: number) => { const pages = []; let cursor = null; for (let i = 0; i < 30; i++) { const r: any = await member.query(fn, { ...args, paginationOpts: { numItems, cursor } }); pages.push({ n: r.page.length, done: r.isDone }); if (r.isDone) break; cursor = r.continueCursor; } return pages; };
  return { f, member, deal, acme, mine, agent, hide, restrict, walk, list: { orgId: f.orgId, objectId: deal.object._id } };
}

it('records.list: a filter value only hidden deals hold pages like a value nobody holds', async () => {
  const w = await world(); await w.hide(3, 777777); await w.restrict();
  const pages = (value: number) => w.walk(api.records.list, { ...w.list, filter: { fieldId: w.deal.fields.amount._id, value } }, 1);
  expect(await pages(777777)).toEqual(await pages(888888));
});
it('records.list: hidden deals do not change the recent-first pages', async () => {
  const w = await world(); await w.restrict();
  const before = await w.walk(api.records.list, w.list, 5);
  await w.hide(7);
  expect(await w.walk(api.records.list, w.list, 5)).toEqual(before);
});
it('records.list: sorting by a field still pages only readable rows', async () => {
  const w = await world(); await w.hide(7); await w.restrict();
  expect(await w.walk(api.records.list, { ...w.list, sort: { fieldId: w.deal.fields.amount._id, direction: 'desc' } }, 1)).toEqual([{ n: 1, done: true }]);
});
it('agent GET /records: a filter value only hidden deals hold looks like a value nobody holds', async () => {
  const w = await world(); await w.hide(3, 777777);
  const call = (value: number) => rest(w.f.t, w.agent.key)('GET', `/api/v1/records?object=opportunity&filter=amount&value=${value}&limit=1`);
  const [hit, miss] = [await call(777777), await call(888888)];
  expect({ status: hit.status, body: hit.json }).toEqual({ status: miss.status, body: miss.json });
});
it('records.related: hidden deals linked to a readable company do not change the pages', async () => {
  const w = await world(); await w.restrict();
  const args = { orgId: w.f.orgId, recordId: w.acme, fieldId: w.deal.fields.company._id };
  const before = await w.walk(api.records.related, args, 5);
  await w.hide(7);
  expect(await w.walk(api.records.related, args, 5)).toEqual(before);
});
it('events.forOrg: activity on hidden deals does not change the member\'s pages', async () => {
  const w = await world(); await w.restrict();
  const before = await w.walk(api.events.forOrg, { orgId: w.f.orgId }, 2);
  await w.hide(7);
  expect(await w.walk(api.events.forOrg, { orgId: w.f.orgId }, 2)).toEqual(before);
});
it('events.forOrg: a restricted member pages every event they can see, newest first, once each', async () => {
  const w = await world(); await w.restrict();
  const all = (await w.member.query(api.events.forOrg, { orgId: w.f.orgId, paginationOpts: { numItems: 100, cursor: null } })).page.map((e: any) => e._id);
  const paged: string[] = []; let cursor = null;
  for (let i = 0; i < 50; i++) { const r: any = await w.member.query(api.events.forOrg, { orgId: w.f.orgId, paginationOpts: { numItems: 1, cursor } }); paged.push(...r.page.map((e: any) => e._id)); if (r.isDone) break; cursor = r.continueCursor; }
  expect(all.length).toBeGreaterThan(1);
  expect(paged).toEqual(all);
});
it('csv.exportPage: hidden deals do not change the export pages', async () => {
  const w = await world(); await w.restrict();
  const pages = async () => { const out = []; let cursor = null; for (let i = 0; i < 10; i++) { const r: any = await w.member.query(api.csv.exportPage, { ...w.list, cursor }); out.push({ rows: r.rows.length, done: r.done }); if (r.done) break; cursor = r.cursor; } return out; };
  const before = await pages();
  await w.hide(201);
  expect(await pages()).toEqual(before);
}, 30000);

// The list path must return exactly what the index path returns for the same query,
// restricted to readable rows: same filter, same order, same tie-break (IV round 4).
it('the list path sorts and filters exactly like the index path, including ties, -0 and non-BMP text', async () => {
  const f = await userAndOrg(), deal = await objectFields(f.client, f.orgId, 'opportunity');
  const create = (name: string, amount?: number) => f.client.mutation(api.records.create, { orgId: f.orgId, objectId: deal.object._id, values: { [deal.fields.name._id]: name, ...(amount === undefined ? {} : { [deal.fields.amount._id]: amount }) } }).then((r: any) => r.recordId);
  // UTF-16 order and code-point order disagree on the emoji and U+FFFD; three deals tie on 5.
  const listed: string[] = [];
  for (const [name, amount] of [['b', 5], ['B', 5], ['a', undefined], ['é', 0], ['Z', -1], ['😀x', 1e9], ['�y', 2.5], ['10', 5], ['9', 7]] as [string, number | undefined][]) { listed.push(await create(name, amount)); await create('hidden ' + name, amount); }
  const member = f.t.withIdentity({ tokenIdentifier: 'clerk|lister', name: 'Lister' }), userId = await member.mutation(api.users.store, {});
  await member.mutation(api.invites.accept, { token: (await f.client.mutation(api.invites.create, { orgId: f.orgId, role: 'member' })).token });
  const memberId = await f.t.run(async (ctx: any) => (await ctx.db.query('members').collect()).find((m: any) => m.userId === userId)._id);
  // The scope lists the records newest first, so a lost tie-break shows up as a different order.
  await f.client.mutation(anyApi['authority/policies'].setMember, { orgId: f.orgId, memberId, scopes: [{ objectId: deal.object._id, records: [...listed].reverse(), fields: 'all' }], hiddenFieldIds: [] });
  const ids = async (client: any, extra: any, numItems: number) => { const out: string[] = []; let cursor = null; for (let i = 0; i < 40; i++) { const r: any = await client.query(api.records.list, { orgId: f.orgId, objectId: deal.object._id, ...extra, paginationOpts: { numItems, cursor } }); out.push(...r.page.map((x: any) => x._id)); if (r.isDone) break; cursor = r.continueCursor; } return out; };
  const amount = deal.fields.amount._id, name = deal.fields.name._id;
  const cases: Record<string, any> = { recent: {}, amountAsc: { sort: { fieldId: amount, direction: 'asc' } }, amountDesc: { sort: { fieldId: amount, direction: 'desc' } }, nameAsc: { sort: { fieldId: name, direction: 'asc' } }, nameDesc: { sort: { fieldId: name, direction: 'desc' } }, amount5: { filter: { fieldId: amount, value: 5 } }, amount5Desc: { filter: { fieldId: amount, value: 5 }, sort: { fieldId: amount, direction: 'desc' } }, amountMinus0: { filter: { fieldId: amount, value: -0 } }, amountEmpty: { filter: { fieldId: amount, value: null } } };
  const differ: Record<string, unknown> = {};
  for (const [label, extra] of Object.entries(cases)) {
    const expected = (await ids(f.client, extra, 100)).filter(id => listed.includes(id)), got = await ids(member, extra, 2);
    if (JSON.stringify(expected) !== JSON.stringify(got)) differ[label] = { expected, got };
  }
  expect(differ).toEqual({});
  // The sort really is by code point: U+FFFD before the emoji.
  const titles = async (extra: any) => (await member.query(api.records.list, { orgId: f.orgId, objectId: deal.object._id, ...extra, paginationOpts: { numItems: 20, cursor: null } })).page.map((r: any) => r.title);
  expect(await titles(cases.nameAsc)).toEqual(['10', '9', 'B', 'Z', 'a', 'b', 'é', '�y', '😀x']);
  expect(await titles(cases.amountMinus0)).toEqual([]);
});

it('a cursor from the other path is refused cleanly, not with a server error', async () => {
  const f = await userAndOrg(), deal = await objectFields(f.client, f.orgId, 'opportunity');
  const list = (cursor: string) => f.client.query(api.records.list, { orgId: f.orgId, objectId: deal.object._id, paginationOpts: { numItems: 2, cursor } });
  await expect(list('list:0')).rejects.toMatchObject({ data: { code: 'VALIDATION', message: 'Invalid cursor' } });
  await expect(list('not a cursor')).rejects.toMatchObject({ data: { code: 'VALIDATION', message: 'Invalid cursor' } });
  await expect(f.client.query(api.events.forOrg, { orgId: f.orgId, paginationOpts: { numItems: 2, cursor: 'events:start:' } })).rejects.toMatchObject({ data: { code: 'VALIDATION', message: 'Invalid cursor' } });
});
