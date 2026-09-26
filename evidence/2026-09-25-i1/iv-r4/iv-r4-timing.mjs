// IV round 4: is the agent search latency drift seen in the rerun of R3-F2 caused by unreadable rows, or by the
// backend growing? Two identical workspaces A and B (member + scoped agent, one readable deal each). Only A
// gets unreadable deals. Latency of A and B is sampled alternately at each stage, so drift hits both equally.
// Every sample follows a write to that workspace's opportunity index, so cached results are not reused where the
// query reads that range. Usage: I1_EVIDENCE_DIR=<dir> node evidence/2026-09-25-i1/iv-r4/iv-r4-timing.mjs
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { anyApi } from 'convex/server';
import { withAuthority, evidencePath } from '../../../ops/authority/local.mjs';
import { tenant as makeTenant } from '../../../ops/authority/service-fixture.mjs';
const median = xs => +[...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)].toFixed(2);
const report = await withAuthority(async f => {
  f.run('integrations/connections:registerProvider', { provider: 'fake', enabled: true }); f.run('integrations/budgets:configure', { cap: 100000, maxConcurrent: 1000, maxPerRun: 1000, maxSteps: 5, maxRecipients: 100 });
  const ws = async label => {
    const t = await makeTenant(f, label), objects = await t.human.query(anyApi.objects.list, { orgId: t.orgId }), o = objects.find(x => x.key === 'opportunity');
    const d = await t.human.query(anyApi.objects.get, { orgId: t.orgId, objectId: o._id }), F = Object.fromEntries(d.fields.map(x => [x.key, x]));
    const mk = name => t.human.mutation(anyApi.records.create, { orgId: t.orgId, objectId: o._id, values: { [F.name._id]: name } }, { skipQueue: true }).then(r => r.recordId);
    const mine = await mk('Mine Deal');
    const client = f.client(label + randomUUID()), userId = await client.mutation(anyApi.users.store, {}); const inv = await t.human.mutation(anyApi.invites.create, { orgId: t.orgId, role: 'member' }); await client.mutation(anyApi.invites.accept, { token: inv.token });
    const memberId = (await t.human.query(anyApi.orgs.members, { orgId: t.orgId })).find(m => m.user._id === userId).member._id;
    await t.human.mutation(anyApi['authority/policies'].setMember, { orgId: t.orgId, memberId, scopes: [{ objectId: o._id, records: [mine], fields: 'all' }], hiddenFieldIds: [] });
    const agent = await t.human.action(anyApi.agents.createScoped, { orgId: t.orgId, name: 'a', origin: 'external' });
    await t.human.mutation(anyApi['authority/grants'].grant, { orgId: t.orgId, target: agent.agentId, capability: 'read', scope: { kind: 'records', objectId: o._id, records: [mine], fields: d.fields.map(x => x._id) }, mode: 'direct', delegate: false, expiresAt: Date.now() + 3600000 });
    const get = async path => { const s = performance.now(); const r = await fetch(f.site + '/api/v1/' + path, { headers: { authorization: 'Bearer ' + agent.key } }); await r.text(); return performance.now() - s; };
    const q = async (fn, args) => { const s = performance.now(); await client.query(fn, { orgId: t.orgId, ...args }); return performance.now() - s; };
    const probes = {
      agentSearchRecent: () => get('search?q=&object=opportunity&limit=1'), agentSearchText: () => get('search?q=Deal&limit=1'), agentRecords: () => get('records?object=opportunity&limit=1'), agentMe: () => get('me'),
      memberSearchRecent: () => q(anyApi.records.search, { objectId: o._id, text: '', limit: 1 }), memberList: () => q(anyApi.records.list, { objectId: o._id, paginationOpts: { numItems: 1, cursor: null } }),
    };
    return { mk, probes, hidden: 0 };
  };
  const A = await ws('A'), B = await ws('B');
  const stage = async () => { const out = { A: {}, B: {} }; for (const k of Object.keys(A.probes)) { const xs = { A: [], B: [] }; for (let i = 0; i < 25; i++) for (const [n, w] of [['A', A], ['B', B]]) { await w.mk('touch ' + i); xs[n].push(await w.probes[k]()); } out.A[k] = median(xs.A); out.B[k] = median(xs.B); } return out; };
  const s0 = await stage();
  for (let i = 0; i < 1000; i += 100) await Promise.all(Array.from({ length: 100 }, (_, j) => A.mk('Hidden Deal ' + (i + j))));
  const s1 = await stage();
  const result = { note: 'A gets 1000 unreadable deals between stages; B gets none. Both also get 150 "touch" rows per stage (unreadable too).', before: s0, after1000HiddenInA: s1 };
  console.log('TIMING2', JSON.stringify(result));
  return result;
}, { safetySim: true });
writeFileSync(evidencePath('iv-r4-timing.json'), JSON.stringify(report, null, 2) + '\n');
