// IV round 3 timing: uncached latency of recent-first search vs number of unreadable newer rows. Derived from iv-r3.mjs.
// Original header: IV round 3: attacks on I1 revision 2 (babeb42). Same harness and rules as ../iv-r2/iv-r2.mjs:
// isolated local Convex (ports patched to 3560/3561, see local-ports.patch), synthetic JWTs and data,
// no providers, spend or sends. Needs ops/authority/fixture-iv.ts from ../iv-r2.
// Each check compares what one restricted caller sees BEFORE and AFTER only unreadable rows change
// (or a hidden value vs a value nobody has). Any difference is an existence/count/value oracle.
// Usage: I1_EVIDENCE_DIR=<dir> node evidence/2026-09-25-i1/iv-r3/iv-r3.mjs
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { anyApi } from 'convex/server';
import { withAuthority, evidencePath } from '../../../ops/authority/local.mjs';
import { tenant as makeTenant } from '../../../ops/authority/service-fixture.mjs';

const only = process.env.IV_ONLY ? new RegExp(process.env.IV_ONLY) : null;
const errText = e => String(e?.data ? JSON.stringify(e.data) : e?.message ?? e);
const attempt = async fn => { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: errText(e).slice(0, 300) }; } };
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const report = await withAuthority(async f => {
  const results = [];
  const check = async (id, claim, name, fn) => {
    if (only && !only.test(id)) return;
    try { const observed = await fn(); results.push({ id, claim, name, status: 'PASS', observed }); console.log('PASS', id, name); }
    catch (e) { results.push({ id, claim, name, status: 'FAIL', error: String(e?.message ?? e).slice(0, 20000) }); console.log('FAIL', id, name, '\n   ', String(e?.message ?? e).slice(0, 900)); }
  };
  f.run('integrations/connections:registerProvider', { provider: 'fake', enabled: true });
  f.run('integrations/budgets:configure', { cap: 100000, maxConcurrent: 1000, maxPerRun: 1000, maxSteps: 5, maxRecipients: 100 });
  const rest = key => async (method, path) => { const s = performance.now(); const r = await fetch(f.site + '/api/v1/' + path, { method, headers: { authorization: 'Bearer ' + key } }); const text = await r.text(); return { status: r.status, text, ms: performance.now() - s }; };
  const invite = async (t, role, label) => { const client = f.client(label + '-' + randomUUID()), userId = await client.mutation(anyApi.users.store, {}); const inv = await t.human.mutation(anyApi.invites.create, { orgId: t.orgId, role }); await client.mutation(anyApi.invites.accept, { token: inv.token }); return { client, userId }; };
  const memberOf = async (t, userId) => (await t.human.query(anyApi.orgs.members, { orgId: t.orgId })).find(m => m.user._id === userId).member;
  const objectOf = async (t, key) => { const objects = await t.human.query(anyApi.objects.list, { orgId: t.orgId }), o = objects.find(x => x.key === key), d = await t.human.query(anyApi.objects.get, { orgId: t.orgId, objectId: o._id }); return { object: o, fields: Object.fromEntries(d.fields.map(x => [x.key, x])), objects }; };

  // One workspace. A member and an external agent can read exactly one opportunity ("Mine Deal"),
  // every company, and every other object. Everything else in opportunity is unreadable to them.
  const t = await makeTenant(f, 'r3');
  const opp = await objectOf(t, 'opportunity'), co = await objectOf(t, 'company'), F = opp.fields;
  const acme = (await t.human.mutation(anyApi.records.create, { orgId: t.orgId, objectId: co.object._id, values: { [co.fields.name._id]: 'Acme Readable' } })).recordId;
  const newOpp = (name, amount, extra = {}) => t.human.mutation(anyApi.records.create, { orgId: t.orgId, objectId: opp.object._id, values: { [F.name._id]: name, [F.amount._id]: amount, [F.company._id]: acme, ...extra } }, { skipQueue: true }).then(r => r.recordId);
  const mine = await newOpp('Mine Deal', 100);
  const m = await invite(t, 'member', 'scoped');
  await t.human.mutation(anyApi['authority/policies'].setMember, { orgId: t.orgId, memberId: (await memberOf(t, m.userId))._id, scopes: [{ objectId: opp.object._id, records: [mine], fields: 'all' }, ...opp.objects.filter(o => o.key !== 'opportunity').map(o => ({ objectId: o._id, records: 'all', fields: 'all' }))], hiddenFieldIds: [] });
  const agent = await t.human.action(anyApi.agents.createScoped, { orgId: t.orgId, name: 'r3-scoped', origin: 'external' });
  await t.human.mutation(anyApi['authority/grants'].grant, { orgId: t.orgId, target: agent.agentId, capability: 'read', scope: { kind: 'records', objectId: opp.object._id, records: [mine], fields: Object.values(F).map(x => x._id) }, mode: 'direct', delegate: false, expiresAt: Date.now() + 3600000 });
  await t.human.mutation(anyApi['authority/grants'].grant, { orgId: t.orgId, target: agent.agentId, capability: 'read', scope: { kind: 'records', objectId: co.object._id, records: 'all', fields: Object.values(co.fields).map(x => x._id) }, mode: 'direct', delegate: false, expiresAt: Date.now() + 3600000 });
  const call = rest(agent.key);
  let hidden = 0;
  const addHidden = async (n, amount = 5000, prefix = 'Hidden Deal') => { for (let i = 0; i < n; i += 50) await Promise.all(Array.from({ length: Math.min(50, n - i) }, (_, j) => newOpp(`${prefix} ${hidden + i + j}`, amount))); hidden += n; };

  // Each sample first creates one more unreadable deal, which invalidates the cached query result,
  // so every timed call is a real execution.
  const sample = async n => { const member = [], agentMs = []; for (let i = 0; i < n; i++) { await addHidden(1); let s = performance.now(); const r = await m.client.query(anyApi.records.search, { orgId: t.orgId, objectId: opp.object._id, text: '', limit: 1 }); member.push(performance.now() - s); assert.deepEqual(r.map(x => x.title), ['Mine Deal']); await addHidden(1); const a = await call('GET', 'search?q=&object=opportunity&limit=1'); agentMs.push(a.ms); assert.deepEqual(JSON.parse(a.text).map(x => x.title), ['Mine Deal']); } return { hiddenAtEnd: hidden, memberMedianMs: +median(member).toFixed(2), agentMedianMs: +median(agentMs).toFixed(2), memberMs: member.map(x => +x.toFixed(1)), agentMs: agentMs.map(x => +x.toFixed(1)) }; };
  const low = await sample(25);
  await addHidden(900 - hidden);
  const high = await sample(25);
  console.log('TIMING', JSON.stringify({ low: { hidden: low.hiddenAtEnd, member: low.memberMedianMs, agent: low.agentMedianMs }, high: { hidden: high.hiddenAtEnd, member: high.memberMedianMs, agent: high.agentMedianMs } }));
  return { low, high };
}, { safetySim: true });
writeFileSync(evidencePath('iv-r3-timing.json'), JSON.stringify(report, null, 2) + '\n');
