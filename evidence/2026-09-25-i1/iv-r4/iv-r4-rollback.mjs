// IV round 4: the additive events.by_object index across a code+schema rollback to babeb42 and forward again,
// on one non-empty local backend. Only the convex/ files that differ between babeb42 and 87d4c10 are swapped.
// Usage: I1_EVIDENCE_DIR=<dir> node evidence/2026-09-25-i1/iv-r4/iv-r4-rollback.mjs
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { anyApi } from 'convex/server';
import { withAuthority, evidencePath } from '../../../ops/authority/local.mjs';
import { tenant as makeTenant } from '../../../ops/authority/service-fixture.mjs';
const root = process.cwd(), OLD = 'babeb42';
const changed = execFileSync('git', ['diff', '--name-status', OLD, 'HEAD', '--', 'convex'], { encoding: 'utf8' }).trim().split('\n').map(l => l.split('\t')).filter(([, p]) => !p.endsWith('.test.ts'));
const report = await withAuthority(async f => {
  f.run('integrations/connections:registerProvider', { provider: 'fake', enabled: true }); f.run('integrations/budgets:configure', { cap: 100000, maxConcurrent: 1000, maxPerRun: 1000, maxSteps: 5, maxRecipients: 100 });
  const steps = [];
  const t = await makeTenant(f, 'rb');
  const objects = await t.human.query(anyApi.objects.list, { orgId: t.orgId }), o = objects.find(x => x.key === 'opportunity'), d = await t.human.query(anyApi.objects.get, { orgId: t.orgId, objectId: o._id }), F = Object.fromEntries(d.fields.map(x => [x.key, x]));
  const mk = name => t.human.mutation(anyApi.records.create, { orgId: t.orgId, objectId: o._id, values: { [F.name._id]: name } }).then(r => r.recordId);
  const mine = [await mk('mine 1'), await mk('mine 2')]; await mk('hidden 1');
  const client = f.client('m-' + randomUUID()), userId = await client.mutation(anyApi.users.store, {}); const inv = await t.human.mutation(anyApi.invites.create, { orgId: t.orgId, role: 'member' }); await client.mutation(anyApi.invites.accept, { token: inv.token });
  const memberId = (await t.human.query(anyApi.orgs.members, { orgId: t.orgId })).find(m => m.user._id === userId).member._id;
  await t.human.mutation(anyApi['authority/policies'].setMember, { orgId: t.orgId, memberId, scopes: [{ objectId: o._id, records: mine, fields: 'all' }, ...objects.filter(x => x.key !== 'opportunity').map(x => ({ objectId: x._id, records: 'all', fields: 'all' }))], hiddenFieldIds: [] });
  const feed = async () => { const ids = []; let cursor = null; for (let i = 0; i < 50; i++) { const r = await client.query(anyApi.events.forOrg, { orgId: t.orgId, paginationOpts: { numItems: 2, cursor } }); ids.push(...r.page.map(e => e._id)); if (r.isDone) break; cursor = r.continueCursor; } return ids; };
  const expected = async () => (await t.human.query(anyApi.events.forOrg, { orgId: t.orgId, paginationOpts: { numItems: 1000, cursor: null } })).page.filter(e => e.objectId !== o._id || mine.includes(e.recordId)).map(e => e._id);
  const count = () => f.run('authorityFixtureIv:everything', { orgId: t.orgId }).events.length;
  const v1 = await feed(); steps.push({ step: 'on 87d4c10', memberFeed: v1.length, expected: (await expected()).length, events: count() }); assert.deepEqual(v1, await expected());
  const back = await f.reload(() => { for (const [status, path] of changed) { const dest = join(f.scratch, path); if (status === 'A') rmSync(dest, { force: true }); else writeFileSync(dest, execFileSync('git', ['show', `${OLD}:${path}`], { cwd: root })); } });
  steps.push({ step: 'rolled back to babeb42 code and schema', deployed: /Convex functions ready/.test(back), indexDropped: /by_object/.test(back) ? back.split('\n').filter(l => /by_object|index/i.test(l)).slice(0, 3) : 'no index lines in log', events: count() });
  await mk('made during rollback'); await t.human.mutation(anyApi.records.update, { orgId: t.orgId, recordId: mine[0], values: { [F.name._id]: 'mine 1 renamed in rollback' } });
  const oldFeed = await client.query(anyApi.events.forOrg, { orgId: t.orgId, paginationOpts: { numItems: 50, cursor: null } });
  steps.push({ step: 'old code reads', memberPageLen: oldFeed.page.length, events: count() });
  const fwd = await f.reload(() => { for (const [, path] of changed) { const src = join(root, path), dest = join(f.scratch, path); try { writeFileSync(dest, readFileSync(src)); } catch { rmSync(dest, { force: true }); } } });
  const v2 = await feed(), exp2 = await expected();
  steps.push({ step: 'forward again to 87d4c10 (index rebuilt)', deployed: /Convex functions ready/.test(fwd), memberFeed: v2.length, expected: exp2.length, same: JSON.stringify(v2) === JSON.stringify(exp2), events: count() });
  assert.deepEqual(v2, exp2);
  console.log(JSON.stringify(steps, null, 1));
  return { changed, steps };
}, { safetySim: true });
writeFileSync(evidencePath('iv-r4-rollback.json'), JSON.stringify(report, null, 2) + '\n');
console.log('ROLLBACK PASS');
