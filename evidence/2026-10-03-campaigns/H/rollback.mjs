// Rollback check on an isolated local backend, synthetic data only:
// 1. this build writes batches (applied, pending, direct) and a suggestion with a link delta;
// 2. the previous release's convex/ (BASE, default aa68030) is pushed over the same data;
// 3. the old code must start and serve records, history and suggestions;
// 4. forward again, the batches are intact.
// Run from the repo root: node evidence/2026-10-03-campaigns/H/rollback.mjs
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { anyApi } from 'convex/server';
import { withAuthority } from '../../../ops/authority/local.mjs';

const base = process.env.BASE ?? 'aa68030';
const until = async (check, ms = 60000) => { const end = Date.now() + ms; for (;;) { const value = await check(); if (value) return value; if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 250)); } };
await withAuthority(async ({ scratch, root, client, site, reload }) => {
  const owner = client('rollback-owner');
  await owner.mutation(anyApi.users.store, {});
  const orgId = await owner.mutation(anyApi.orgs.create, { name: 'Rollback check' });
  const agent = await owner.action(anyApi.agents.create, { orgId, name: 'bulk', grants: [{ action: 'update', objectKey: 'campaign' }] });
  const call = async (method, path, body, headers = {}) => { const r = await fetch(site + path, { method, headers: { authorization: `Bearer ${agent.key}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, json: await r.json() }; };
  const objects = await owner.query(anyApi.objects.list, { orgId });
  const shape = async key => { const object = objects.find(o => o.key === key); const detail = await owner.query(anyApi.objects.get, { orgId, objectId: object._id }); return { object, f: Object.fromEntries(detail.fields.map(f => [f.key, f._id])) }; };
  const [opp, person, campaign] = await Promise.all(['opportunity', 'person', 'campaign'].map(shape));
  const create = async (o, values) => (await owner.mutation(anyApi.records.create, { orgId, objectId: o.object._id, values: Object.fromEntries(Object.entries(values).map(([k, v]) => [o.f[k], v])) })).recordId;
  const deals = []; for (let i = 0; i < 6; i++) deals.push(await create(opp, { name: `Deal ${i}`, stage: 'new' }));
  const ada = await create(person, { name: 'Ada' }), ben = await create(person, { name: 'Ben' }), spring = await create(campaign, { name: 'Spring' });
  const applied = (await call('POST', '/api/v1/batches', { reason: 'qualify', changes: deals.slice(0, 3).map(record => ({ action: 'update', record, values: { stage: 'qualified' } })) })).json.batch;
  const pending = (await call('POST', '/api/v1/batches', { reason: 'later', changes: deals.slice(3).map(record => ({ action: 'update', record, values: { stage: 'contacted' } })) })).json.batch;
  const direct = (await call('POST', '/api/v1/batches', { reason: 'list', direct: true, changes: [{ action: 'update', record: spring, links: { people: { add: [ada] } } }] }, { 'idempotency-key': 'rollback-1' })).json.batch;
  const suggestion = (await call('POST', '/api/v1/suggestions', { action: 'update', record: spring, links: { people: { add: [ben] } }, reason: 'one more' })).json.suggestion;
  await owner.mutation(anyApi.batches.apply, { orgId, batchId: applied.id });
  await until(async () => (await owner.query(anyApi.batches.list, { orgId, status: 'done' })).length === 2);
  console.log('new build wrote: batches done 2 (one direct), pending 1; suggestion with a link delta', suggestion.id);

  const old = mkdtempSync(join(tmpdir(), 'remold-rollback-base-'));
  execFileSync('tar', ['-x', '-C', old], { input: execFileSync('git', ['archive', base, 'convex'], { cwd: root }) });
  const keep = new Set(['auth.config.ts']);
  const output = await reload(() => {
    for (const entry of readdirSync(join(scratch, 'convex'))) if (!keep.has(entry) && !entry.startsWith('authorityFixture') && entry !== '_generated') rmSync(join(scratch, 'convex', entry), { recursive: true, force: true });
    cpSync(join(old, 'convex'), join(scratch, 'convex'), { recursive: true, filter: p => !p.endsWith('.test.ts') && !p.endsWith('test.helpers.ts') && !p.endsWith('test.setup.ts') && !p.endsWith('auth.config.ts') });
  });
  console.log('old release pushed:', /Convex functions ready/.test(output) ? 'functions ready' : output.slice(-400));
  const detail = await owner.query(anyApi.records.get, { orgId, recordId: deals[0] });
  const history = await owner.query(anyApi.events.forRecord, { orgId, recordId: deals[0] });
  console.log('old release: deal stage', detail.record.values[opp.f.stage], '| history', history.map(e => `${e.action} by ${e.actorName}`).join(', '));
  const listed = await owner.query(anyApi.suggestions.list, { orgId });
  console.log('old release: pending suggestions', listed.length);
  const result = await owner.mutation(anyApi.suggestions.apply, { orgId, suggestionId: suggestion.id });
  const after = await owner.query(anyApi.records.get, { orgId, recordId: spring });
  console.log('old release applied the link-delta suggestion:', result.status, '| Spring people now', JSON.stringify(after.record.values[campaign.f.people]), '(link delta ignored by the old code)');
  console.log('old release: batches route', (await call('GET', `/api/v1/batches/${applied.id}`)).status, '| records update still works', !!(await owner.mutation(anyApi.records.update, { orgId, recordId: deals[5], values: { [opp.f.amount]: 10 } })));
  rmSync(old, { recursive: true, force: true });

  await reload(() => cpSync(join(root, 'convex'), join(scratch, 'convex'), { recursive: true, filter: p => !p.endsWith('.test.ts') && !p.endsWith('test.helpers.ts') && !p.endsWith('test.setup.ts') && !p.endsWith('auth.config.ts') }));
  const counts = Object.fromEntries(await Promise.all(['pending', 'done'].map(async status => [status, (await owner.query(anyApi.batches.list, { orgId, status })).length])));
  console.log('forward again, batches by status:', JSON.stringify(counts), '| replayed direct batch', (await call('POST', '/api/v1/batches', { reason: 'list', direct: true, changes: [{ action: 'update', record: spring, links: { people: { add: [ada] } } }] }, { 'idempotency-key': 'rollback-1' })).json.batch.id === direct.id ? 'same id' : 'DIFFERENT');
  assert.deepEqual(counts, { pending: 1, done: 2 });
  await owner.mutation(anyApi.batches.apply, { orgId, batchId: pending.id });
  await until(async () => (await owner.query(anyApi.batches.list, { orgId, status: 'done' })).length === 3);
  console.log('forward again: the batch left pending across the rollback applied, deal 3 stage', (await owner.query(anyApi.records.get, { orgId, recordId: deals[3] })).record.values[opp.f.stage]);
  return {};
});
