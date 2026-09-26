import { expect, it } from 'vitest';
import { anyApi } from 'convex/server';
import { api, objectFields, rest, userAndOrg } from '../../convex/test.helpers';

// Every list with a fixed limit must fill it with rows the caller can read. Here the
// caller can read one row per list, and enough unreadable rows sit ahead of it to use
// up the whole limit, including the larger take(200) the pre-revision-2 code used. Taking the limit first and filtering afterwards would return
// nothing, which tells the caller the hidden rows exist (IV round 3, T).
const DAY = 86400000;
const grant = (f: any, agentId: any, objectId: any, records: any, fields: any[]) => f.client.mutation(anyApi['authority/grants'].grant, { orgId: f.orgId, target: agentId, capability: 'read', scope: { kind: 'records', objectId, records, fields }, mode: 'direct', delegate: false, expiresAt: Date.now() + 600000 });
const memberId = (f: any) => f.t.run(async (ctx: any) => (await ctx.db.query('members').collect())[0]._id);
const restrictMember = async (f: any, scopes: any[]) => f.client.mutation(anyApi['authority/policies'].setMember, { orgId: f.orgId, memberId: await memberId(f), scopes, hiddenFieldIds: [] });
async function many(n: number, make: (i: number) => Promise<unknown>) { for (let i = 0; i < n; i++) await make(i); }

async function taskWorld(hiddenCount: number) {
  const f = await userAndOrg(), task = await objectFields(f.client, f.orgId, 'task'), today = Math.floor(Date.now() / DAY) * DAY;
  const create = (title: string, due: number) => f.client.mutation(api.records.create, { orgId: f.orgId, objectId: task.object._id, values: { [task.fields.title._id]: title, [task.fields.dueDate._id]: due, [task.fields.done._id]: false } }).then((r: any) => r.recordId);
  // Hidden tasks are due earlier, so they come first in due-date order.
  await many(hiddenCount, i => create('Hidden ' + i, today - 2 * DAY));
  const mine = await create('Mine', today);
  return { f, task, today, mine, fields: Object.values(task.fields).map((x: any) => x._id) };
}
async function dealWorld(hiddenCount: number) {
  const f = await userAndOrg(), deal = await objectFields(f.client, f.orgId, 'opportunity');
  const create = (name: string) => f.client.mutation(api.records.create, { orgId: f.orgId, objectId: deal.object._id, values: { [deal.fields.name._id]: name, [deal.fields.stage._id]: 'new' } }).then((r: any) => r.recordId);
  const hidden: any[] = []; await many(hiddenCount, async i => hidden.push(await create('Hidden ' + i)));
  const mine = await create('Mine');
  // Hidden deals have been untouched longest, so they come first in the quiet list.
  await f.t.run(async (ctx: any) => { for (const id of hidden) await ctx.db.patch(id, { updatedAt: Date.now() - 40 * DAY }); await ctx.db.patch(mine, { updatedAt: Date.now() - 20 * DAY }); });
  return { f, deal, mine, fields: Object.values(deal.fields).map((x: any) => x._id) };
}

it('member today: due tasks fill the list with readable tasks', async () => {
  const w = await taskWorld(200); await restrictMember(w.f, [{ objectId: w.task.object._id, records: [w.mine], fields: 'all' }]);
  expect((await w.f.client.query(api.today.get, { orgId: w.f.orgId, today: w.today })).tasks.map((r: any) => r._id)).toEqual([w.mine]);
}, 60000);
it('agent today: due tasks fill the list with readable tasks', async () => {
  const w = await taskWorld(200), agent = await w.f.client.action(api.agents.createScoped, { orgId: w.f.orgId, name: 'today', origin: 'external' });
  await grant(w.f, agent.agentId, w.task.object._id, [w.mine], w.fields);
  expect((await rest(w.f.t, agent.key)('GET', '/api/v1/today')).json.tasks.map((r: any) => r.id)).toEqual([w.mine]);
}, 60000);
it('member today: quiet deals fill the list with readable deals', async () => {
  const w = await dealWorld(200); await restrictMember(w.f, [{ objectId: w.deal.object._id, records: [w.mine], fields: 'all' }]);
  expect((await w.f.client.query(api.today.get, { orgId: w.f.orgId, today: Date.now() })).quiet.map((r: any) => r._id)).toEqual([w.mine]);
}, 60000);
it('agent today: quiet deals fill the list with readable deals', async () => {
  const w = await dealWorld(200), agent = await w.f.client.action(api.agents.createScoped, { orgId: w.f.orgId, name: 'quiet', origin: 'external' });
  await grant(w.f, agent.agentId, w.deal.object._id, [w.mine], w.fields);
  expect((await rest(w.f.t, agent.key)('GET', '/api/v1/today')).json.quiet.map((r: any) => r.id)).toEqual([w.mine]);
}, 60000);

async function relatedWorld(kind: 'lookup' | 'links') {
  const f = await userAndOrg(), company = await objectFields(f.client, f.orgId, 'company'), person = await objectFields(f.client, f.orgId, 'person'), task = await objectFields(f.client, f.orgId, 'task');
  const target = kind === 'lookup'
    ? (await f.client.mutation(api.records.create, { orgId: f.orgId, objectId: company.object._id, values: { [company.fields.name._id]: 'Acme' } })).recordId
    : (await f.client.mutation(api.records.create, { orgId: f.orgId, objectId: task.object._id, values: { [task.fields.title._id]: 'Blocker' } })).recordId;
  const source = kind === 'lookup' ? person : task;
  const create = (title: string) => f.client.mutation(api.records.create, { orgId: f.orgId, objectId: source.object._id, values: kind === 'lookup' ? { [person.fields.name._id]: title, [person.fields.company._id]: target } : { [task.fields.title._id]: title, [task.fields.blockedBy._id]: [target] } }).then((r: any) => r.recordId);
  // One hundred hidden records point at the target before the caller's own one does.
  await many(100, i => create('Hidden ' + i));
  const mine = await create('Mine');
  const agent = await f.client.action(api.agents.createScoped, { orgId: f.orgId, name: 'related', origin: 'external' });
  const targetObject = kind === 'lookup' ? company : task;
  if (kind === 'lookup') await grant(f, agent.agentId, company.object._id, [target], Object.values(company.fields).map((x: any) => x._id));
  await grant(f, agent.agentId, source.object._id, kind === 'lookup' ? [mine] : [mine, target], Object.values(source.fields).map((x: any) => x._id));
  const field = kind === 'lookup' ? 'person.company' : 'task.blockedBy';
  return { ids: async () => ((await rest(f.t, agent.key)('GET', `/api/v1/records/${target}/related?field=${field}`)).json as any[]).map(r => r.id), mine, targetObject };
}
it('agent related through a lookup fills its limit with readable records', async () => {
  const w = await relatedWorld('lookup'); expect(await w.ids()).toEqual([w.mine]);
}, 30000);
it('agent related through a links field fills its limit with readable records', async () => {
  const w = await relatedWorld('links'); expect(await w.ids()).toEqual([w.mine]);
}, 30000);

async function suggestionWorld(hiddenCount: number) {
  const f = await userAndOrg(), company = await objectFields(f.client, f.orgId, 'company');
  const create = (name: string) => f.client.mutation(api.records.create, { orgId: f.orgId, objectId: company.object._id, values: { [company.fields.name._id]: name } }).then((r: any) => r.recordId);
  const mine = await create('Mine'), secret = await create('Secret');
  const proposer = await f.client.action(api.agents.create, { orgId: f.orgId, name: 'proposer' });
  const suggest = (recordId: any) => f.t.run((ctx: any) => ctx.db.insert('suggestions', { orgId: f.orgId, agentId: proposer.agentId, status: 'pending', change: { action: 'update', objectId: company.object._id, recordId, values: { [company.fields.name._id]: 'x' } }, recordId, before: {}, reason: 'r' }));
  // The caller's suggestion is the oldest; the newest-first list meets the hidden ones first.
  const own = await suggest(mine); await many(hiddenCount, () => suggest(secret));
  return { f, company, mine, own };
}
it('member suggestion list fills its limit with readable suggestions', async () => {
  const w = await suggestionWorld(200); await restrictMember(w.f, [{ objectId: w.company.object._id, records: [w.mine], fields: 'all' }]);
  expect((await w.f.client.query(api.suggestions.list, { orgId: w.f.orgId })).map((r: any) => r.suggestion._id)).toEqual([w.own]);
}, 30000);
it('agent suggestion list fills its limit with readable suggestions', async () => {
  const w = await suggestionWorld(100), agent = await w.f.client.action(api.agents.createScoped, { orgId: w.f.orgId, name: 'reader', origin: 'external' });
  await grant(w.f, agent.agentId, w.company.object._id, [w.mine], Object.values(w.company.fields).map((x: any) => x._id));
  expect(((await rest(w.f.t, agent.key)('GET', '/api/v1/suggestions')).json as any[]).map(r => r.id)).toEqual([w.own]);
}, 30000);

async function inboxWorld() {
  const f = await userAndOrg(), other = await f.t.withIdentity({ tokenIdentifier: 'clerk|other', name: 'Other' }).mutation(api.users.store, {});
  // One hundred private notes from someone else come before the caller's own item.
  await many(100, i => f.t.run((ctx: any) => ctx.db.insert('agentInbox', { orgId: f.orgId, text: 'private ' + i, source: 'api', from: { kind: 'user', id: other }, status: 'pending', audience: 'author' })));
  return f;
}
it('member inbox list fills its limit with items the member may see', async () => {
  const f = await inboxWorld(), company = await objectFields(f.client, f.orgId, 'company');
  await restrictMember(f, [{ objectId: company.object._id, records: [], fields: 'all' }]);
  const own = await f.client.mutation(api.inbox.add, { orgId: f.orgId, text: 'mine' });
  expect((await f.client.query(api.inbox.list, { orgId: f.orgId })).map((r: any) => r._id)).toEqual([own]);
}, 30000);
it('agent inbox list fills its limit with items the agent may see', async () => {
  const f = await inboxWorld(), agent = await f.client.action(api.agents.createScoped, { orgId: f.orgId, name: 'inbox', origin: 'external' });
  const own = (await rest(f.t, agent.key)('POST', '/api/v1/inbox', { text: 'mine' })).json.id;
  expect(((await rest(f.t, agent.key)('GET', '/api/v1/inbox')).json as any[]).map(r => r.id)).toEqual([own]);
}, 30000);
