// Rollback check on an isolated local backend, synthetic data only:
// 1. this build sets readAllObjects on one agent and narrows another;
// 2. the previous release's convex/ (c5e2e6b) is pushed over the same data, plain and then with
//    only the agents.readAllObjects schema line added (a schema-only rollback build);
// 3. forward again: the access written before the rollback is still in force.
// Run from the repo root: node evidence/2026-10-03-campaigns/D/rollback.mjs
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { anyApi } from 'convex/server';
import { withAuthority } from '../../../ops/authority/local.mjs';

const base = process.env.BASE ?? 'c5e2e6b';
const skip = p => p.endsWith('.test.ts') || p.endsWith('test.helpers.ts') || p.endsWith('test.setup.ts') || p.endsWith('auth.config.ts');
await withAuthority(async ({ scratch, root, client, site, logs }) => {
  const owner = client('rollback-owner');
  await owner.mutation(anyApi.users.store, {});
  const orgId = await owner.mutation(anyApi.orgs.create, { name: 'Rollback check' });
  const all = await owner.action(anyApi.agents.create, { orgId, name: 'reads all' });
  const narrow = await owner.action(anyApi.agents.create, { orgId, name: 'narrowed', grants: [{ action: 'create', objectKey: 'company' }, { action: 'create', objectKey: 'task' }] });
  await owner.mutation(anyApi.agents.setReadAccess, { orgId, agentId: all.agentId, readAllObjects: true, objectIds: [] });
  const objects = await owner.query(anyApi.objects.list, { orgId });
  await owner.mutation(anyApi.agents.setReadAccess, { orgId, agentId: narrow.agentId, readAllObjects: false, objectIds: objects.filter(o => o.key !== 'company').map(o => o._id) });
  await owner.mutation(anyApi.objects.create, { orgId, key: 'venue', label: 'Venue', labelPlural: 'Venues' });
  const reads = async key => (await (await fetch(site + '/api/v1/objects', { headers: { authorization: `Bearer ${key}` } })).json()).map(o => o.key);
  const before = { all: await reads(all.key), narrow: await reads(narrow.key) };
  console.log('this build: reads-all agent sees venue', before.all.includes('venue'), '| narrowed agent sees company', before.narrow.includes('company'));

  const old = mkdtempSync(join(tmpdir(), 'remold-rollback-base-'));
  execFileSync('tar', ['-x', '-C', old], { input: execFileSync('git', ['archive', base, 'convex'], { cwd: root }) });
  const swap = from => { for (const entry of readdirSync(join(scratch, 'convex'))) if (entry !== 'auth.config.ts' && !entry.startsWith('authorityFixture') && entry !== '_generated') rmSync(join(scratch, 'convex', entry), { recursive: true, force: true }); cpSync(from, join(scratch, 'convex'), { recursive: true, filter: p => !skip(p) }); };
  const push = async edit => { const offset = logs().length; edit(); const deadline = Date.now() + 120000; for (;;) { const out = logs().slice(offset); if (/Convex functions ready/.test(out)) return 'functions ready'; const failed = /(Schema validation failed[^\n]*\n?[^\n]*|Object contains extra field[^\n]*)/i.exec(out); if (failed) return 'refused: ' + failed[1].replace(/\s+/g, ' ').slice(0, 300); if (Date.now() > deadline) return 'no result in 120s: ' + out.slice(-300); await new Promise(r => setTimeout(r, 200)); } };
  console.log('plain previous release:', await push(() => swap(join(old, 'convex'))));
  const schema = join(old, 'convex/schema.ts'), text = readFileSync(schema, 'utf8');
  writeFileSync(schema, text.replace('readObjectIds: v.optional(v.array(v.id("objects"))), hiddenFieldIds', 'readObjectIds: v.optional(v.array(v.id("objects"))), readAllObjects: v.optional(v.boolean()), hiddenFieldIds'));
  const shim = await push(() => swap(join(old, 'convex')));
  console.log('previous release + readAllObjects schema line:', shim);
  if (shim === 'functions ready') {
    const after = { all: await reads(all.key), narrow: await reads(narrow.key) };
    console.log('previous code: reads-all agent sees', after.all.length, 'objects, venue', after.all.includes('venue'), '| narrowed agent sees company', after.narrow.includes('company'));
  }
  rmSync(old, { recursive: true, force: true });

  console.log('forward again:', await push(() => swap(join(root, 'convex'))));
  const listed = await owner.query(anyApi.agents.list, { orgId });
  const forward = { all: await reads(all.key), narrow: await reads(narrow.key) };
  console.log('forward: reads-all flag', listed.find(a => a._id === all.agentId).readAllObjects, '| sees venue', forward.all.includes('venue'), '| narrowed grants', JSON.stringify(listed.find(a => a._id === narrow.agentId).grants));
  assert.deepEqual(forward, before);
  return {};
});
