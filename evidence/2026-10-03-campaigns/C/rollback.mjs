// Rollback check on an isolated local backend, synthetic data only:
// 1. this build writes shape proposals (pending, applied, failed) and applies a new object;
// 2. the previous release's convex/ (git 371a62c) is pushed over the same data;
// 3. the old code must start and serve the workspace, including the agent-made object.
// Run from the repo root: node evidence/2026-10-03-campaigns/C/rollback.mjs
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { anyApi } from 'convex/server';
import { withAuthority } from '../../../ops/authority/local.mjs';

const base = process.env.BASE ?? '371a62c';
await withAuthority(async ({ scratch, root, client, site, reload, run }) => {
  const owner = client('rollback-owner');
  await owner.mutation(anyApi.users.store, {});
  const orgId = await owner.mutation(anyApi.orgs.create, { name: 'Rollback check' });
  const agent = await owner.action(anyApi.agents.create, { orgId, name: 'shaper', role: 'admin' });
  const propose = async body => (await (await fetch(site + '/api/v1/shape/proposals', { method: 'POST', headers: { authorization: `Bearer ${agent.key}`, 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'rollback check', ...body }) })).json()).proposal;
  const venue = await propose({ kind: 'addObject', key: 'venue', label: 'Venue', labelPlural: 'Venues', fields: [{ key: 'capacity', label: 'Capacity', type: 'number' }, { key: 'owner', label: 'Owner', type: 'lookup', target: 'company' }] });
  const budget = await propose({ kind: 'addField', object: 'opportunity', key: 'budget', label: 'Budget', type: 'number' });
  await propose({ kind: 'relabel', object: 'company', label: 'Account', labelPlural: 'Accounts' });
  await owner.mutation(anyApi.shapeSuggestions.apply, { orgId, id: venue.id });
  const company = (await owner.query(anyApi.objects.list, { orgId })).find(o => o.key === 'opportunity');
  await owner.mutation(anyApi.fields.create, { orgId, objectId: company._id, key: 'budget', label: 'Budget', type: 'text' });
  const failed = await owner.mutation(anyApi.shapeSuggestions.apply, { orgId, id: budget.id });
  assert.equal(failed.status, 'failed');
  console.log('new build wrote: 1 applied, 1 failed, 1 pending shape proposal; agent read extended to Venue');

  // Swap in the previous release's functions and schema; keep the scratch-only auth config and fixtures.
  const old = mkdtempSync(join(tmpdir(), 'remold-rollback-base-'));
  execFileSync('tar', ['-x', '-C', old], { input: execFileSync('git', ['archive', base, 'convex'], { cwd: root }) });
  const keep = new Set(['auth.config.ts']);
  const output = await reload(() => {
    for (const entry of readdirSync(join(scratch, 'convex'))) if (!keep.has(entry) && !entry.startsWith('authorityFixture') && entry !== '_generated') rmSync(join(scratch, 'convex', entry), { recursive: true, force: true });
    cpSync(join(old, 'convex'), join(scratch, 'convex'), { recursive: true, filter: p => !p.endsWith('.test.ts') && !p.endsWith('test.helpers.ts') && !p.endsWith('test.setup.ts') && !p.endsWith('auth.config.ts') });
  });
  console.log('old release pushed:', /Convex functions ready/.test(output) ? 'functions ready' : output.slice(-400));
  const objects = await owner.query(anyApi.objects.list, { orgId }), venueObject = objects.find(o => o.key === 'venue');
  assert.ok(venueObject, 'old release lists the agent-made object');
  const detail = await owner.query(anyApi.objects.get, { orgId, objectId: venueObject._id });
  const name = detail.fields.find(f => f.key === 'name'), capacity = detail.fields.find(f => f.key === 'capacity');
  const created = await owner.mutation(anyApi.records.create, { orgId, objectId: venueObject._id, values: { [name._id]: 'The Hall', [capacity._id]: 120 } });
  console.log('old release: objects', objects.map(o => o.key).join(','), '| venue fields', detail.fields.map(f => f.key).join(','), '| record created', !!created.recordId);
  const me = await (await fetch(site + '/api/v1/me', { headers: { authorization: `Bearer ${agent.key}` } })).json();
  const seen = await (await fetch(site + '/api/v1/objects', { headers: { authorization: `Bearer ${agent.key}` } })).json();
  console.log('old release agent REST: /me ok', !!me.agent, '| agent sees venue', seen.some(o => o.key === 'venue'), '| shape route', (await fetch(site + '/api/v1/shape/proposals', { headers: { authorization: `Bearer ${agent.key}` } })).status);
  rmSync(old, { recursive: true, force: true });

  // Forward again: the proposals written before the rollback are still there.
  await reload(() => cpSync(join(root, 'convex'), join(scratch, 'convex'), { recursive: true, filter: p => !p.endsWith('.test.ts') && !p.endsWith('test.helpers.ts') && !p.endsWith('test.setup.ts') && !p.endsWith('auth.config.ts') }));
  const counts = Object.fromEntries(await Promise.all(['pending', 'applied', 'failed'].map(async status => [status, (await owner.query(anyApi.shapeSuggestions.list, { orgId, status })).length])));
  console.log('forward again, shape proposals by status:', JSON.stringify(counts));
  assert.deepEqual(counts, { pending: 1, applied: 1, failed: 1 });
  void run;
  return {};
});
