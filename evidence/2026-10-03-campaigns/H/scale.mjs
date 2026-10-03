// Full-size batches on an isolated local Convex backend (real transaction limits), synthetic data only:
// 1000 stage updates, then 1000 deletes of companies that people and a campaign link to.
// Run from the repo root: node evidence/2026-10-03-campaigns/H/scale.mjs
import assert from 'node:assert/strict';
import { anyApi } from 'convex/server';
import { withAuthority } from '../../../ops/authority/local.mjs';

const until = async (check, ms = 600000) => { const end = Date.now() + ms; for (;;) { const value = await check(); if (value) return value; if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 500)); } };
await withAuthority(async ({ client, site, run }) => {
  const owner = client('scale-owner');
  await owner.mutation(anyApi.users.store, {});
  const orgId = await owner.mutation(anyApi.orgs.create, { name: 'Scale check' });
  const agent = await owner.action(anyApi.agents.create, { orgId, name: 'bulk' });
  const post = async body => { const started = Date.now(), r = await fetch(site + '/api/v1/batches', { method: 'POST', headers: { authorization: `Bearer ${agent.key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }); const json = await r.json(); assert.equal(r.status, 201, JSON.stringify(json).slice(0, 400)); return { batch: json.batch, ms: Date.now() - started }; };
  const objects = await owner.query(anyApi.objects.list, { orgId });
  const shape = async key => { const object = objects.find(o => o.key === key); const detail = await owner.query(anyApi.objects.get, { orgId, objectId: object._id }); return { object, f: Object.fromEntries(detail.fields.map(f => [f.key, f._id])) }; };
  const [opp, company, person, campaign] = await Promise.all(['opportunity', 'company', 'person', 'campaign'].map(shape));
  const make = async (o, rows) => { const ids = []; for (let i = 0; i < rows.length; i += 100) ids.push(...await Promise.all(rows.slice(i, i + 100).map(async values => (await owner.mutation(anyApi.records.create, { orgId, objectId: o.object._id, values: Object.fromEntries(Object.entries(values).map(([k, v]) => [o.f[k], v])) })).recordId))); return ids; };
  const deals = await make(opp, Array.from({ length: 1000 }, (_, i) => ({ name: `Deal ${i}`, stage: 'new' })));
  const companies = await make(company, Array.from({ length: 1000 }, (_, i) => ({ name: `Company ${i}` })));
  await make(person, Array.from({ length: 200 }, (_, i) => ({ name: `Person ${i}`, company: companies[i] })));
  await make(campaign, [{ name: 'Spring', companies: companies.slice(0, 50) }]);
  console.log('fixture: 1000 deals, 1000 companies, 200 people pointing at the first 200, a campaign linking the first 50');

  const timed = async (label, body) => {
    const { batch, ms } = await post(body);
    const counted = Date.now();
    await until(async () => !(await owner.query(anyApi.batches.list, { orgId })).find(b => b._id === batch.id)?.counting);
    if (batch.counts.delete) console.log(`${label}: impact counted in ${Date.now() - counted} ms`);
    const started = Date.now();
    await owner.mutation(anyApi.batches.apply, { orgId, batchId: batch.id });
    const done = await until(async () => (await owner.query(anyApi.batches.list, { orgId, status: 'done' })).find(b => b._id === batch.id));
    console.log(`${label}: submit ${ms} ms (${batch.summary}); apply ${Date.now() - started} ms; progress ${JSON.stringify(done.progress)}; impact ${done.impact}`);
    return done;
  };
  const updates = await timed('1000 updates', { reason: 'scale', changes: deals.map(record => ({ action: 'update', record, values: { stage: 'contacted' } })) });
  assert.deepEqual(updates.progress, { done: 1000, applied: 1000, conflicted: 0, failed: 0 });
  const deletes = await timed('1000 deletes', { reason: 'scale', changes: companies.map(record => ({ action: 'delete', record })) });
  assert.equal(deletes.impact, 250);
  assert.deepEqual(deletes.progress, { done: 1000, applied: 1000, conflicted: 0, failed: 0 });
  void run;
  return {};
});
