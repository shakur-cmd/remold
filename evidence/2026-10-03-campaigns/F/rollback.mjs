// Rollback check on an isolated local backend, synthetic data only:
// 1. this build writes saved views (shared, personal) and addView proposals (one applied, one pending);
// 2. the previous release's convex/ (git aa68030) is pushed over the same data;
// 3. does the push succeed, and does the old code still serve the workspace and the Suggestions list?
// MODE=views-only writes no proposals; MODE=keep-schema pushes the old functions with this build's (additive) schema.
// Run from the repo root: node evidence/2026-10-03-campaigns/F/rollback.mjs
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { anyApi } from 'convex/server';
import { withAuthority } from '../../../ops/authority/local.mjs';

const base = process.env.BASE ?? 'aa68030', mode = process.env.MODE ?? 'default';
const outcome = async call => { try { return { ok: true, value: await call() }; } catch (error) { return { ok: false, error: String(error?.message ?? error).slice(0, 300) }; } };
await withAuthority(async ({ scratch, root, client, site, logs }) => {
  const owner = client('rollback-owner');
  await owner.mutation(anyApi.users.store, {});
  const orgId = await owner.mutation(anyApi.orgs.create, { name: 'Rollback check' });
  const opp = (await owner.query(anyApi.objects.list, { orgId })).find(o => o.key === 'opportunity');
  const fields = Object.fromEntries((await owner.query(anyApi.objects.get, { orgId, objectId: opp._id })).fields.map(f => [f.key, f]));
  await owner.mutation(anyApi.records.create, { orgId, objectId: opp._id, values: { [fields.name._id]: 'Deal', [fields.stage._id]: 'proposal' } });
  await owner.mutation(anyApi.views.create, { orgId, objectId: opp._id, name: 'Shared', layout: 'board', groupFieldId: fields.stage._id, columns: [], filters: [], shared: true, pinned: true });
  await owner.mutation(anyApi.views.create, { orgId, objectId: opp._id, name: 'Mine', layout: 'table', columns: [fields.amount._id], filters: [], range: { fieldId: fields.closeDate._id, relative: 'thisMonth' } });
  const agent = await owner.action(anyApi.agents.create, { orgId, name: 'shaper', role: 'admin' });
  const propose = async body => (await (await fetch(site + '/api/v1/shape/proposals', { method: 'POST', headers: { authorization: `Bearer ${agent.key}`, 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'rollback check', kind: 'addView', object: 'opportunity', ...body }) })).json()).proposal;
  await propose({ kind: 'addField', key: 'budget', label: 'Budget', type: 'number' });
  if (mode !== 'views-only') {
    const applied = await propose({ name: 'Agent view', columns: ['amount'] });
    await propose({ name: 'Pending agent view', filters: [{ field: 'stage', value: 'won' }] });
    await owner.mutation(anyApi.shapeSuggestions.apply, { orgId, id: applied.id });
  }
  console.log(`mode ${mode}; new build wrote: views (shared, personal${mode === 'views-only' ? '' : ', agent'}), 1 pending addField${mode === 'views-only' ? '' : ', 1 applied and 1 pending addView proposal'}`);

  const old = mkdtempSync(join(tmpdir(), 'remold-rollback-base-'));
  execFileSync('tar', ['-x', '-C', old], { input: execFileSync('git', ['archive', base, 'convex'], { cwd: root }) });
  const keep = new Set(['auth.config.ts']);
  // Waits for either outcome: the old functions start, or the push is refused.
  const offset = logs().length;
  for (const entry of readdirSync(join(scratch, 'convex'))) if (!keep.has(entry) && !entry.startsWith('authorityFixture') && entry !== '_generated') rmSync(join(scratch, 'convex', entry), { recursive: true, force: true });
  cpSync(join(old, 'convex'), join(scratch, 'convex'), { recursive: true, filter: p => !p.endsWith('.test.ts') && !p.endsWith('test.helpers.ts') && !p.endsWith('test.setup.ts') && !p.endsWith('auth.config.ts') });
  if (mode === 'keep-schema') for (const file of ['schema.ts', 'lib/metadata.ts', 'lib/views.ts', 'lib/days.ts']) cpSync(join(root, 'convex', file), join(scratch, 'convex', file));
  const deadline = Date.now() + 150000;
  while (!/Convex functions ready|schema validation failed|Schema validation failed|not valid|extra field|Hit an error/i.test(logs().slice(offset)) && Date.now() < deadline) await new Promise(r => setTimeout(r, 200));
  const output = logs().slice(offset);
  console.log('old release push:', /Convex functions ready/.test(output) ? 'functions ready' : 'did not start: ' + output.split('\n').filter(l => /rror|schema|views|addView|does not match/i.test(l)).slice(0, 6).join(' / '));
  const listed = await outcome(() => owner.query(anyApi.objects.list, { orgId }));
  console.log('old release objects.list:', listed.ok ? `${listed.value.length} objects` : listed.error);
  const rows = await outcome(() => owner.query(anyApi.records.list, { orgId, objectId: opp._id, paginationOpts: { cursor: null, numItems: 10 } }));
  console.log('old release records.list:', rows.ok ? rows.value.page.map(r => r.title).join(',') : rows.error);
  const pending = await outcome(() => owner.query(anyApi.shapeSuggestions.list, { orgId, status: 'pending' }));
  console.log('old release shapeSuggestions.list (pending):', pending.ok ? JSON.stringify(pending.value.map(r => ({ kind: r.kind, summary: r.summary ?? null, details: r.details ?? null }))) : pending.error);
  const rest = await fetch(site + '/api/v1/shape/proposals', { headers: { authorization: `Bearer ${agent.key}` } });
  console.log('old release agent GET /shape/proposals:', rest.status);
  rmSync(old, { recursive: true, force: true });
  return {};
});
