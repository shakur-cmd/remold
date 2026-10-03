// Rollback check on an isolated local backend, synthetic data only:
// 1. this build archives an object, retires a field, reorders (audit `before`), and stores lifecycle proposals;
// 2. the previous release's convex/ (git aa68030) is pushed over the same data: expected to be refused by schema validation;
// 3. the previous release's code with only this build's schema (schema.ts, the lib/metadata.ts validators it imports, and lib/slots.ts which they import) is pushed: must start and serve;
// 4. forward again to this build: nothing lost.
// Run from the repo root: node evidence/2026-10-03-campaigns/G/rollback.mjs
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { anyApi } from 'convex/server';
import { withAuthority } from '../../../ops/authority/local.mjs';

const base = process.env.BASE ?? 'aa68030';
const tests = p => !p.endsWith('.test.ts') && !p.endsWith('test.helpers.ts') && !p.endsWith('test.setup.ts') && !p.endsWith('auth.config.ts');
await withAuthority(async ({ scratch, root, client, site, reload }) => {
  const owner = client('rollback-owner');
  await owner.mutation(anyApi.users.store, {});
  const orgId = await owner.mutation(anyApi.orgs.create, { name: 'Rollback check' });
  const venueId = await owner.mutation(anyApi.objects.create, { orgId, key: 'venue', label: 'Venue', labelPlural: 'Venues' });
  await owner.mutation(anyApi.fields.create, { orgId, objectId: venueId, key: 'city', label: 'City', type: 'text' });
  await owner.mutation(anyApi.fields.create, { orgId, objectId: venueId, key: 'notes', label: 'Notes', type: 'text', indexed: false });
  const fields = Object.fromEntries((await owner.query(anyApi.fields.list, { orgId, objectId: venueId })).map(f => [f.key, f]));
  await owner.mutation(anyApi.records.create, { orgId, objectId: venueId, values: { [fields.name._id]: 'Old Hall', [fields.city._id]: 'Leeds' } });
  const agent = await owner.action(anyApi.agents.create, { orgId, name: 'shaper', role: 'admin' });
  const propose = async body => { const r = await fetch(site + '/api/v1/shape/proposals', { method: 'POST', headers: { authorization: `Bearer ${agent.key}`, 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'rollback check', ...body }) }); const json = await r.json(); assert.equal(r.status, 201, JSON.stringify(json)); return json.proposal; };
  await owner.mutation(anyApi.fields.reorder, { orgId, objectId: venueId, fieldIds: [fields.city._id, fields.name._id, fields.notes._id] });
  const retire = await propose({ kind: 'retireField', object: 'venue', field: 'city' });
  await owner.mutation(anyApi.shapeSuggestions.apply, { orgId, id: retire.id });
  await propose({ kind: 'archiveObject', object: 'venue' });
  await owner.mutation(anyApi.objects.setArchived, { orgId, objectId: venueId, archived: true });
  console.log('this build wrote: venue archived, city retired by an applied proposal, a pending archive proposal, a reorder audit with before');

  const old = mkdtempSync(join(tmpdir(), 'remold-rollback-base-'));
  execFileSync('tar', ['-x', '-C', old], { input: execFileSync('git', ['archive', base, 'convex'], { cwd: root }) });
  const swap = (extra = []) => () => {
    for (const entry of readdirSync(join(scratch, 'convex'))) if (entry !== 'auth.config.ts' && !entry.startsWith('authorityFixture') && entry !== '_generated') rmSync(join(scratch, 'convex', entry), { recursive: true, force: true });
    cpSync(join(old, 'convex'), join(scratch, 'convex'), { recursive: true, filter: tests });
    for (const file of extra) cpSync(join(root, file), join(scratch, file));
  };
  const refused = await reload(swap(), true);
  console.log('previous release as is:', (/Schema validation failed[^\n]*\n?[^\n]*/i.exec(refused)?.[0] ?? refused.slice(-300)).replace(/\s+/g, ' ').slice(0, 400));
  const output = await reload(swap(['convex/schema.ts', 'convex/lib/metadata.ts', 'convex/lib/slots.ts']));
  console.log('previous release code + this schema:', /Convex functions ready/.test(output) ? 'functions ready' : output.slice(-400));
  const objects = await owner.query(anyApi.objects.list, { orgId }), venue = objects.find(o => o.key === 'venue');
  const detail = await owner.query(anyApi.objects.get, { orgId, objectId: venue._id });
  const created = await owner.mutation(anyApi.records.create, { orgId, objectId: venue._id, values: { [fields.name._id]: 'The Yard' } });
  const shapes = await owner.query(anyApi.shapeSuggestions.list, { orgId, status: 'pending' });
  const seen = await (await fetch(site + '/api/v1/objects', { headers: { authorization: `Bearer ${agent.key}` } })).json();
  console.log('old code: venue listed (archive ignored)', !!venue, '| venue fields', detail.fields.map(f => f.key).join(','), '| record created', !!created.recordId, '| pending proposals listed', shapes.length, JSON.stringify(shapes.map(s => ({ kind: s.kind, summary: s.summary ?? null }))), '| agent sees venue', seen.some(o => o.key === 'venue'));
  rmSync(old, { recursive: true, force: true });

  await reload(() => cpSync(join(root, 'convex'), join(scratch, 'convex'), { recursive: true, filter: tests }));
  const after = (await owner.query(anyApi.objects.list, { orgId })).find(o => o.key === 'venue');
  const live = (await owner.query(anyApi.objects.get, { orgId, objectId: venueId })).fields.map(f => f.key);
  const pending = await owner.query(anyApi.shapeSuggestions.list, { orgId, status: 'pending' });
  console.log('forward again: venue archived', after.archived === true, '| live fields', live.join(','), '| pending', pending.map(p => p.summary).join('; '));
  assert.equal(after.archived, true);
  assert.deepEqual(live, ['name', 'notes']);
  return {};
});
