// IV round 5 (from ../iv-r4/iv-r4-rollback.mjs): the three additive indexes of revision 4 (suggestions.by_object_status,
// agentInbox.by_org_status_from, agentInbox.by_org_status_audience), plus lists that use them, across a rollback to
// 87d4c10 and forward. Original header: IV round 4: the additive events.by_object index across a code+schema rollback to babeb42 and forward again,
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
const root = process.cwd(), OLD = process.env.OLD ?? '87d4c10';
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
  const agent = await t.human.action(anyApi.agents.createScoped, { orgId: t.orgId, name: 'p', origin: 'external' });
  for (const cap of ['read', 'propose']) await t.human.mutation(anyApi['authority/grants'].grant, { orgId: t.orgId, target: agent.agentId, capability: cap, scope: { kind: 'records', objectId: o._id, records: 'all', fields: d.fields.map(x => x._id) }, mode: 'direct', delegate: false, expiresAt: Date.now() + 3600000 });
  const propose = async record => { const r = await fetch(f.site + '/api/v1/suggestions', { method: 'POST', headers: { authorization: 'Bearer ' + agent.key, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'update', record, values: { name: 'x' + Math.random() }, reason: 'r' }) }); if (r.status !== 201) throw new Error(await r.text()); };
  const pending = async () => ({ suggestions: (await client.query(anyApi.suggestions.list, { orgId: t.orgId })).length, inbox: (await client.query(anyApi.inbox.list, { orgId: t.orgId })).map(i => i.text) });
  const hiddenId = (await t.human.query(anyApi.records.list, { orgId: t.orgId, objectId: o._id, paginationOpts: { numItems: 10, cursor: null } })).page.find(r => !mine.includes(r._id))._id;
  await propose(mine[0]); await propose(hiddenId); await client.mutation(anyApi.inbox.add, { orgId: t.orgId, text: 'member before' }); await t.human.mutation(anyApi.inbox.add, { orgId: t.orgId, text: 'owner private before' });
  const count = () => f.run('authorityFixtureIv:everything', { orgId: t.orgId }).events.length;
  const p1 = await pending(); const v1 = await feed(); steps.push({ step: 'on HEAD', pending: p1, memberFeed: v1.length, expected: (await expected()).length, events: count() }); assert.deepEqual(v1, await expected());
  const back = await f.reload(() => { for (const [status, path] of changed) { const dest = join(f.scratch, path); if (status === 'A') rmSync(dest, { force: true }); else writeFileSync(dest, execFileSync('git', ['show', `${OLD}:${path}`], { cwd: root })); } });
  steps.push({ step: 'rolled back to ' + OLD + ' code and schema', droppedIndexes: back.split('\n').filter(l => /\[-\]/.test(l)).map(l => l.trim()), deployed: /Convex functions ready/.test(back), indexDropped: /by_object/.test(back) ? back.split('\n').filter(l => /by_object|index/i.test(l)).slice(0, 3) : 'no index lines in log', events: count() });
  await mk('made during rollback'); await t.human.mutation(anyApi.records.update, { orgId: t.orgId, recordId: mine[0], values: { [F.name._id]: 'mine 1 renamed in rollback' } });
  await propose(mine[1]); await propose(hiddenId); await client.mutation(anyApi.inbox.add, { orgId: t.orgId, text: 'member during rollback' });
  const pOld = await pending();
  const oldFeed = await client.query(anyApi.events.forOrg, { orgId: t.orgId, paginationOpts: { numItems: 50, cursor: null } });
  steps.push({ step: 'old code reads', pending: pOld, memberPageLen: oldFeed.page.length, events: count() });
  const fwd = await f.reload(() => { for (const [, path] of changed) { const src = join(root, path), dest = join(f.scratch, path); try { writeFileSync(dest, readFileSync(src)); } catch { rmSync(dest, { force: true }); } } });
  const p2 = await pending(); const v2 = await feed(), exp2 = await expected();
  steps.push({ step: 'forward again to HEAD (indexes rebuilt)', pending: p2, addedIndexes: fwd.split('\n').filter(l => /\[\+\]/.test(l)).map(l => l.trim()), deployed: /Convex functions ready/.test(fwd), memberFeed: v2.length, expected: exp2.length, same: JSON.stringify(v2) === JSON.stringify(exp2), events: count() });
  assert.deepEqual(v2, exp2);
  assert.deepEqual(p2, { suggestions: 2, inbox: ['member before', 'member during rollback'] }, JSON.stringify(p2));
  assert.deepEqual(p1, { suggestions: 1, inbox: ['member before'] }, JSON.stringify(p1));
  console.log(JSON.stringify(steps, null, 1));
  return { changed, steps };
}, { safetySim: true });
writeFileSync(evidencePath('iv-r5-rollback.json'), JSON.stringify(report, null, 2) + '\n');
console.log('ROLLBACK PASS');
