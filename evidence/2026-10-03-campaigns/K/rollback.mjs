// Rollback check on an isolated local backend, synthetic data only:
// 1. this build applies a template (objects, fields, options, starter records), applies an agent's
//    blueprint proposal, and leaves a second blueprint proposal pending;
// 2. the previous release's convex/ (git 050abad) is pushed over the same data;
// 3. the previous release's code with only this build's schema (schema.ts and the lib/metadata.ts
//    and lib/slots.ts validators it imports) is pushed;
// 4. forward again to this build: nothing lost, the pending blueprint still applies.
// Run from the repo root: node evidence/2026-10-03-campaigns/K/rollback.mjs
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { anyApi } from 'convex/server';
import { withAuthority } from '../../../ops/authority/local.mjs';

const base = process.env.BASE ?? '050abad';
const tests = p => !p.endsWith('.test.ts') && !p.endsWith('test.helpers.ts') && !p.endsWith('test.setup.ts') && !p.endsWith('auth.config.ts');
await withAuthority(async ({ scratch, root, client, site, reload }) => {
  const owner = client('rollback-owner');
  await owner.mutation(anyApi.users.store, {});
  const orgId = await owner.mutation(anyApi.orgs.create, { name: 'Rollback check' });
  const [service] = await owner.query(anyApi.blueprints.templates, {});
  await owner.mutation(anyApi.blueprints.apply, { orgId, blueprint: service.blueprint, withRecords: true });
  const agent = await owner.action(anyApi.agents.create, { orgId, name: 'shaper', role: 'admin' });
  const propose = async blueprint => { const r = await fetch(site + '/api/v1/shape/proposals', { method: 'POST', headers: { authorization: `Bearer ${agent.key}`, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'blueprint', reason: 'rollback check', blueprint }) }); const json = await r.json(); assert.equal(r.status, 201, JSON.stringify(json)); return json.proposal; };
  const one = await propose({ version: 1, name: 'Vans', description: '', changes: [{ kind: 'addObject', key: 'van', label: 'Van', labelPlural: 'Vans', fields: [{ key: 'job', label: 'Job', type: 'lookup', target: 'job' }] }] });
  assert.equal((await owner.action(anyApi.shapeSuggestions.applyBlueprint, { orgId, id: one.id, withRecords: false })).status, 'applied');
  const two = await propose({ version: 1, name: 'Parts', description: '', changes: [{ kind: 'addObject', key: 'part', label: 'Part', labelPlural: 'Parts', fields: [{ key: 'van', label: 'Van', type: 'lookup', target: 'van' }] }] });
  const keys = async () => (await owner.query(anyApi.objects.list, { orgId })).map(o => o.key).join(',');
  const before = await keys();
  console.log('this build wrote: service template with starter records, an applied blueprint proposal (Vans), a pending one (Parts). objects:', before);

  const old = mkdtempSync(join(tmpdir(), 'remold-rollback-base-'));
  execFileSync('tar', ['-x', '-C', old], { input: execFileSync('git', ['archive', base, 'convex'], { cwd: root, maxBuffer: 1 << 28 }) });
  const swap = (extra = []) => () => {
    for (const entry of readdirSync(join(scratch, 'convex'))) if (entry !== 'auth.config.ts' && !entry.startsWith('authorityFixture') && entry !== '_generated') rmSync(join(scratch, 'convex', entry), { recursive: true, force: true });
    cpSync(join(old, 'convex'), join(scratch, 'convex'), { recursive: true, filter: tests });
    for (const file of extra) cpSync(join(root, file), join(scratch, file));
  };
  const refused = await reload(swap(), true);
  console.log('previous release as is:', (/Schema validation failed[^\n]*\n?[^\n]*/i.exec(refused)?.[0] ?? refused.slice(-300)).replace(/\s+/g, ' ').slice(0, 400));
  const output = await reload(swap(['convex/schema.ts', 'convex/lib/metadata.ts', 'convex/lib/slots.ts']));
  console.log('previous release code + this schema:', /Convex functions ready/.test(output) ? 'functions ready' : output.slice(-400));
  const objects = await owner.query(anyApi.objects.list, { orgId }), job = objects.find(o => o.key === 'job');
  const fields = await owner.query(anyApi.objects.get, { orgId, objectId: job._id });
  const name = fields.fields.find(f => f.key === 'name');
  const created = await owner.mutation(anyApi.records.create, { orgId, objectId: job._id, values: { [name._id]: 'Made under old code' } });
  const shapes = await owner.query(anyApi.shapeSuggestions.list, { orgId, status: 'pending' }).catch(e => String(e).slice(0, 200));
  const oldApply = await owner.mutation(anyApi.shapeSuggestions.apply, { orgId, id: two.id }).then(r => JSON.stringify(r), e => 'refused: ' + String(e.message ?? e).split('\n')[0].slice(0, 200));
  console.log('old code: objects', (await keys()) === before ? 'unchanged' : await keys(), '| job fields', fields.fields.map(f => f.key).join(','), '| record created', !!created.recordId, '| pending proposals listed', JSON.stringify(Array.isArray(shapes) ? shapes.map(s => ({ kind: s.kind, summary: s.summary ?? null })) : shapes), '| old apply of the pending blueprint', oldApply);
  rmSync(old, { recursive: true, force: true });

  await reload(() => cpSync(join(root, 'convex'), join(scratch, 'convex'), { recursive: true, filter: tests }));
  const pending = await owner.query(anyApi.shapeSuggestions.list, { orgId, status: 'pending' });
  console.log('forward again: objects', (await keys()) === before ? 'unchanged' : await keys(), '| pending', pending.map(p => p.summary).join('; '));
  const applied = await owner.action(anyApi.shapeSuggestions.applyBlueprint, { orgId, id: two.id, withRecords: false });
  console.log('forward again: pending blueprint applies:', applied.status, '| objects', await keys());
  assert.equal(applied.status, 'applied');
  return {};
});
