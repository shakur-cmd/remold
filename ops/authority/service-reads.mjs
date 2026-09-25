import assert from 'node:assert/strict';
import { anyApi } from 'convex/server';
export async function replayReads({ runtime, tenant, test }) {
  await test('Actual human, REST, history, suggestions, CSV, lookup titles and operation DTOs share current masks', async () => {
    const t = await tenant('surface-masks'), objects = await t.human.query(anyApi.objects.list, { orgId: t.orgId });
    const detail = async key => { const object = objects.find(o => o.key === key), data = await t.human.query(anyApi.objects.get, { orgId: t.orgId, objectId: object._id }); return { object, fields: Object.fromEntries(data.fields.map(f => [f.key, f])) }; };
    const company = await detail('company'), person = await detail('person');
    const record = await t.human.mutation(anyApi.records.create, { orgId: t.orgId, objectId: company.object._id, values: { [company.fields.name._id]: 'MASKED_TITLE', [company.fields.city._id]: 'MASKED_CITY' } });
    const linked = await t.human.mutation(anyApi.records.create, { orgId: t.orgId, objectId: person.object._id, values: { [person.fields.name._id]: 'Visible', [person.fields.company._id]: record.recordId } });
    const agent = await t.human.action(anyApi.agents.create, { orgId: t.orgId, name: 'old client' });
    const api = async (method, route, body) => { const r = await fetch(runtime.site + '/api/v1/' + route, { method, headers: { authorization: 'Bearer ' + agent.key, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: r.status, body: await r.json() }; };
    // The tenant factory exposes no deployment credential; site is loopback from the harness.
    const suggested = await api('POST', 'suggestions', { action: 'update', record: record.recordId, values: { city: 'MASKED_PROPOSAL' }, reason: 'MASKED_REASON' }); assert.equal(suggested.status, 201);
    const op = await t.propose('sensitive-output', 1, 1, { payload: { ...t.payload, content: 'MASKED_OPERATION' } });
    const hiddenFieldIds = [company.fields.name._id, company.fields.city._id];
    await t.human.mutation(anyApi['authority/policies'].setAgentMasks, { orgId: t.orgId, agentId: agent.agentId, hiddenFieldIds });
    for (const path of ['objects', 'records/' + record.recordId, 'records/' + linked.recordId, 'records?object=company', 'suggestions', 'search?q=MASKED_TITLE']) {
      const response = await api('GET', path); assert.equal(response.status, 200); assert.doesNotMatch(JSON.stringify(response.body), /MASKED_/);
    }
    assert.equal((await api('GET', 'records?object=company&filter=city&value=MASKED_CITY')).status, 404);
    const member = (await t.human.query(anyApi.orgs.members, { orgId: t.orgId })).find(m => m.user._id === t.userId).member;
    await t.human.mutation(anyApi['authority/policies'].setMember, { orgId: t.orgId, memberId: member._id, hiddenFieldIds });
    const results = await Promise.all([
      t.human.query(anyApi.records.get, { orgId: t.orgId, recordId: record.recordId }),
      t.human.query(anyApi.events.forRecord, { orgId: t.orgId, recordId: record.recordId }),
      t.human.query(anyApi.suggestions.list, { orgId: t.orgId }),
      t.human.query(anyApi.csv.exportPage, { orgId: t.orgId, objectId: company.object._id, cursor: null }), t.get(op),
    ]);
    assert.doesNotMatch(JSON.stringify(results), /MASKED_/);
    await assert.rejects(t.human.mutation(anyApi.capture.save, { orgId: t.orgId, kind: 'company', name: 'MASKED_TITLE' }), /Field not found/);
  });
}
