// IV round 4: read-limit behaviour of the explicit-list path with long lists. For each list size, every
// list-served surface is called once for a member and a scoped agent. Records outcome and latency, then
// adds unreadable rows and repeats at the largest size to show the outcome does not depend on them.
// Usage: I1_EVIDENCE_DIR=<dir> node evidence/2026-09-25-i1/iv-r4/iv-r4-limits.mjs
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { anyApi } from 'convex/server';
import { withAuthority, evidencePath } from '../../../ops/authority/local.mjs';
import { tenant as makeTenant } from '../../../ops/authority/service-fixture.mjs';
const sizes = (process.env.SIZES ?? '1000,2500,4200,6000,9000').split(',').map(Number);
const errText = e => String(e?.data ? JSON.stringify(e.data) : e?.message ?? e).replace(/\[Request ID: [^\]]+\]/g, '').split('\n').filter(Boolean).slice(0, 3).join(' ').slice(0, 220);
const report = await withAuthority(async f => {
  f.run('integrations/connections:registerProvider', { provider: 'fake', enabled: true }); f.run('integrations/budgets:configure', { cap: 100000, maxConcurrent: 1000, maxPerRun: 1000, maxSteps: 5, maxRecipients: 100 });
  const t = await makeTenant(f, 'lim');
  const objects = await t.human.query(anyApi.objects.list, { orgId: t.orgId }), o = objects.find(x => x.key === 'opportunity'), co = objects.find(x => x.key === 'company');
  const d = await t.human.query(anyApi.objects.get, { orgId: t.orgId, objectId: o._id }), F = Object.fromEntries(d.fields.map(x => [x.key, x]));
  const cd = await t.human.query(anyApi.objects.get, { orgId: t.orgId, objectId: co._id });
  const acme = (await t.human.mutation(anyApi.records.create, { orgId: t.orgId, objectId: co._id, values: { [cd.fields.find(x => x.key === 'name')._id]: 'Acme' } })).recordId;
  const ids = []; const make = async (n, prefix) => { const out = []; for (let i = 0; i < n; i += 40) out.push(...(await Promise.all(Array.from({ length: Math.min(40, n - i) }, (_, j) => t.human.mutation(anyApi.records.create, { orgId: t.orgId, objectId: o._id, values: { [F.name._id]: `${prefix} ${i + j}`, [F.amount._id]: (i + j) % 50, [F.company._id]: acme } }, { skipQueue: true }).then(r => r.recordId))))); return out; };
  const client = f.client('lim-' + randomUUID()), userId = await client.mutation(anyApi.users.store, {}); const inv = await t.human.mutation(anyApi.invites.create, { orgId: t.orgId, role: 'member' }); await client.mutation(anyApi.invites.accept, { token: inv.token });
  const memberId = (await t.human.query(anyApi.orgs.members, { orgId: t.orgId })).find(m => m.user._id === userId).member._id;
  const rest = key => async path => { const r = await fetch(f.site + '/api/v1/' + path, { headers: { authorization: 'Bearer ' + key } }); return r.status + ' ' + (r.status === 200 ? 'ok' : (await r.text()).slice(0, 160)); };
  const time = async fn => { const s = performance.now(); try { const v = await fn(); return { ok: true, ms: Math.round(performance.now() - s), v }; } catch (e) { return { ok: false, ms: Math.round(performance.now() - s), error: errText(e) }; } };
  const rows = [];
  const probe = async (n, label) => {
    const list = ids.slice(0, n);
    const set = await time(() => t.human.mutation(anyApi['authority/policies'].setMember, { orgId: t.orgId, memberId, scopes: [{ objectId: o._id, records: list, fields: 'all' }, ...objects.filter(x => x.key !== 'opportunity').map(x => ({ objectId: x._id, records: 'all', fields: 'all' }))], hiddenFieldIds: [] }));
    const agent = await t.human.action(anyApi.agents.createScoped, { orgId: t.orgId, name: 'lim' + n + label, origin: 'external' });
    const g = await time(() => t.human.mutation(anyApi['authority/grants'].grant, { orgId: t.orgId, target: agent.agentId, capability: 'read', scope: { kind: 'records', objectId: o._id, records: list, fields: d.fields.map(x => x._id) }, mode: 'direct', delegate: false, expiresAt: Date.now() + 3600000 }));
    await t.human.mutation(anyApi['authority/grants'].grant, { orgId: t.orgId, target: agent.agentId, capability: 'read', scope: { kind: 'records', objectId: co._id, records: 'all', fields: cd.fields.map(x => x._id) }, mode: 'direct', delegate: false, expiresAt: Date.now() + 3600000 });
    const call = rest(agent.key), row = { size: n, label, setMember: set.ok ? 'ok ' + set.ms + 'ms' : set.error, agentGrant: g.ok ? 'ok ' + g.ms + 'ms' : g.error };
    if (!set.ok) { rows.push(row); console.log(JSON.stringify(row)); return; }
    const q = async (fn, args) => { const r = await time(() => client.query(fn, args)); return r.ok ? `ok ${r.ms}ms` : `ERROR ${r.ms}ms: ${r.error}`; };
    Object.assign(row, {
      list: await q(anyApi.records.list, { orgId: t.orgId, objectId: o._id, paginationOpts: { numItems: 25, cursor: null } }),
      listFilterSort: await q(anyApi.records.list, { orgId: t.orgId, objectId: o._id, filter: { fieldId: F.amount._id, value: 7 }, sort: { fieldId: F.amount._id, direction: 'desc' }, paginationOpts: { numItems: 25, cursor: null } }),
      related: await q(anyApi.records.related, { orgId: t.orgId, recordId: acme, fieldId: F.company._id, paginationOpts: { numItems: 25, cursor: null } }),
      events: await q(anyApi.events.forOrg, { orgId: t.orgId, paginationOpts: { numItems: 25, cursor: null } }),
      csv: await q(anyApi.csv.exportPage, { orgId: t.orgId, objectId: o._id, cursor: null }),
      searchText: await q(anyApi.records.search, { orgId: t.orgId, text: 'deal 12', limit: 10 }),
      searchRecent: await q(anyApi.records.search, { orgId: t.orgId, objectId: o._id, text: '', limit: 10 }),
      today: await q(anyApi.today.get, { orgId: t.orgId, today: Date.now() }),
      agentRecords: g.ok ? await call('records?object=opportunity&limit=25') : 'n/a', agentSearch: g.ok ? await call('search?q=deal&object=opportunity') : 'n/a', agentRelated: g.ok ? await call('records/' + acme + '/related?field=opportunity.company') : 'n/a', agentToday: g.ok ? await call('today') : 'n/a',
    });
    rows.push(row); console.log(JSON.stringify(row));
  };
  ids.push(...await make(Math.max(6000, ...sizes), 'deal'));
  for (const n of sizes) await probe(n, 'no-extra-hidden');
  await make(1500, 'hidden');
  await probe(Math.max(...sizes), 'plus-1500-hidden');
  // Agent grants are stored one per grant, so an agent can hold several lists on one object. Two grants of
  // 3000 give a 6000-record union that no single write could store: does every read fail closed?
  const big = await t.human.action(anyApi.agents.createScoped, { orgId: t.orgId, name: 'two-grants', origin: 'external' });
  for (const part of [ids.slice(0, 3000), ids.slice(3000, 6000)]) await t.human.mutation(anyApi['authority/grants'].grant, { orgId: t.orgId, target: big.agentId, capability: 'read', scope: { kind: 'records', objectId: o._id, records: part, fields: d.fields.map(x => x._id) }, mode: 'direct', delegate: false, expiresAt: Date.now() + 3600000 });
  await t.human.mutation(anyApi['authority/grants'].grant, { orgId: t.orgId, target: big.agentId, capability: 'read', scope: { kind: 'records', objectId: co._id, records: 'all', fields: cd.fields.map(x => x._id) }, mode: 'direct', delegate: false, expiresAt: Date.now() + 3600000 });
  const bc = rest(big.key), union6000 = { agentRecords: await bc('records?object=opportunity&limit=25'), agentSearch: await bc('search?q=deal&object=opportunity'), agentSearchRecent: await bc('search?q=&object=opportunity'), agentRelated: await bc('records/' + acme + '/related?field=opportunity.company'), agentToday: await bc('today'), agentGetOne: await bc('records/' + ids[5]) };
  console.log('UNION6000', JSON.stringify(union6000));
  return { sizes, rows, union6000 };
}, { safetySim: true });
writeFileSync(evidencePath('iv-r4-limits.json'), JSON.stringify(report, null, 2) + '\n');
