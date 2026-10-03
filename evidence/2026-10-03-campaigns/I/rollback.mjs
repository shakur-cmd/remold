// Rollback check on an isolated local backend, synthetic data only:
// 1. this build seeds the Automation object, an agent drafts one, a person turns it on
//    and a won deal runs it (state, run, cap and automation-attributed event rows);
// 2. the previous release's convex/ (BASE, default aa68030) is pushed over the same data;
// 3. the old code must start and serve the workspace, including the created records;
// 4. forward again: the automation and its run history are intact.
// Run from the repo root: node evidence/2026-10-03-campaigns/I/rollback.mjs
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { anyApi } from 'convex/server';
import { withAuthority } from '../../../ops/authority/local.mjs';

const base = process.env.BASE ?? 'aa68030', sleep = ms => new Promise(r => setTimeout(r, ms));
await withAuthority(async ({ scratch, root, client, site, reload }) => {
  execFileSync(process.execPath, [join(root, 'node_modules/convex/bin/main.js'), 'env', 'set', 'REMOLD_AUTOMATION_DAILY_CAP', '50'], { cwd: scratch, env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CONVEX_AGENT_MODE: 'anonymous', CI: '1', CONVEX_DISABLE_METRICS: '1' }, stdio: 'ignore', timeout: 60000 });
  const owner = client('rollback-owner');
  await owner.mutation(anyApi.users.store, {});
  const orgId = await owner.mutation(anyApi.orgs.create, { name: 'Rollback check' });
  const agent = await owner.action(anyApi.agents.create, { orgId, name: 'builder', grants: [{ action: 'create', objectKey: 'automation' }] });
  const drafted = await (await fetch(site + '/api/v1/changes', { method: 'POST', headers: { authorization: `Bearer ${agent.key}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'create', object: 'automation', values: { name: 'Won to project', when: 'fieldChanged', object: 'opportunity', field: 'stage', equals: 'won', actions: JSON.stringify([{ type: 'createRecord', object: 'project', values: { name: 'Delivery: {{record.name}}' } }]) }, reason: 'rollback check' }) })).json();
  const automationId = drafted.record.id;
  await owner.mutation(anyApi.automations.setOn, { orgId, recordId: automationId, on: true });
  const objects = await owner.query(anyApi.objects.list, { orgId }), fieldsOf = async key => Object.fromEntries((await owner.query(anyApi.objects.get, { orgId, objectId: objects.find(o => o.key === key)._id })).fields.map(f => [f.key, f._id]));
  const opp = await fieldsOf('opportunity'), deal = (await owner.mutation(anyApi.records.create, { orgId, objectId: objects.find(o => o.key === 'opportunity')._id, values: { [opp.name]: 'Acme website', [opp.stage]: 'proposal' } })).recordId;
  await owner.mutation(anyApi.records.update, { orgId, recordId: deal, values: { [opp.stage]: 'won' } });
  let view;
  for (let i = 0; i < 60; i++) { view = await owner.query(anyApi.automations.view, { orgId, recordId: automationId }); if (view.runs[0]?.status === 'done') break; await sleep(500); }
  assert.equal(view.runs[0]?.status, 'done');
  console.log('new build wrote: automation on, 1 run done, created', view.runs[0].created.map(c => c.title).join(', '));

  const old = mkdtempSync(join(tmpdir(), 'remold-rollback-base-'));
  execFileSync('tar', ['-x', '-C', old], { input: execFileSync('git', ['archive', base, 'convex'], { cwd: root, maxBuffer: 1 << 28 }) });
  const keep = new Set(['auth.config.ts']);
  const output = await reload(() => {
    for (const entry of readdirSync(join(scratch, 'convex'))) if (!keep.has(entry) && !entry.startsWith('authorityFixture') && entry !== '_generated') rmSync(join(scratch, 'convex', entry), { recursive: true, force: true });
    cpSync(join(old, 'convex'), join(scratch, 'convex'), { recursive: true, filter: p => !p.endsWith('.test.ts') && !p.endsWith('test.helpers.ts') && !p.endsWith('test.setup.ts') && !p.endsWith('auth.config.ts') });
  });
  console.log('old release pushed:', /Convex functions ready/.test(output) ? 'functions ready' : output.slice(-400));
  const oldObjects = await owner.query(anyApi.objects.list, { orgId });
  const projects = await owner.query(anyApi.records.list, { orgId, objectId: oldObjects.find(o => o.key === 'project')._id, paginationOpts: { cursor: null, numItems: 10 } });
  const history = await owner.query(anyApi.events.forRecord, { orgId, recordId: projects.page[0]._id });
  const company = await fieldsOf('company'), created = await owner.mutation(anyApi.records.create, { orgId, objectId: oldObjects.find(o => o.key === 'company')._id, values: { [company.name]: 'Written by the old release' } });
  await owner.mutation(anyApi.records.update, { orgId, recordId: deal, values: { [opp.name]: 'Acme website (old release edit)' } });
  console.log('old release: objects', oldObjects.map(o => o.key).join(','), '| projects', projects.page.map(p => p.title).join(','), '| project history actor', history.map(e => `${e.actor.kind}:${e.actorName}`).join(','), '| record created', !!created.recordId);
  const me = await (await fetch(site + '/api/v1/me', { headers: { authorization: `Bearer ${agent.key}` } })).json();
  console.log('old release agent REST: /me ok', !!me.agent, '| runs route', (await fetch(site + `/api/v1/automations/${automationId}/runs`, { headers: { authorization: `Bearer ${agent.key}` } })).status);
  rmSync(old, { recursive: true, force: true });

  await reload(() => cpSync(join(root, 'convex'), join(scratch, 'convex'), { recursive: true, filter: p => !p.endsWith('.test.ts') && !p.endsWith('test.helpers.ts') && !p.endsWith('test.setup.ts') && !p.endsWith('auth.config.ts') }));
  const after = await owner.query(anyApi.automations.view, { orgId, recordId: automationId });
  console.log('forward again: status', after.status, '| runs', after.runs.map(r => r.status).join(','));
  assert.equal(after.status, 'on'); assert.equal(after.runs.length, 1);
  return {};
});
