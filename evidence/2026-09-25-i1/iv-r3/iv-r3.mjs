// IV round 3: attacks on I1 revision 2 (babeb42). Same harness and rules as ../iv-r2/iv-r2.mjs:
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

  // Snapshot of everything a paginated reader can see: page lengths, isDone per page, ids, total pages.
  const walk = async (fn, args, numItems) => { const pages = []; let cursor = null; for (let i = 0; i < 60; i++) { const r = await m.client.query(fn, { ...args, paginationOpts: { numItems, cursor } }); pages.push({ n: r.page.length, done: r.isDone, ids: r.page.map(x => x._id ?? x.recordId) }); if (r.isDone) break; cursor = r.continueCursor; } return pages; };
  const listArgs = { orgId: t.orgId, objectId: opp.object._id };
  const searchRecent = limit => m.client.query(anyApi.records.search, { orgId: t.orgId, objectId: opp.object._id, text: '', limit });
  const time = async (fn, n = 21) => { const xs = []; for (let i = 0; i < n; i++) { const s = performance.now(); await fn(); xs.push(performance.now() - s); } return +median(xs).toFixed(2); };

  const baseline = {
    list: await walk(anyApi.records.list, listArgs, 5),
    listByAmount: await walk(anyApi.records.list, { ...listArgs, filter: { fieldId: F.amount._id, value: 777777 } }, 1),
    related: await walk(anyApi.records.related, { orgId: t.orgId, recordId: acme, fieldId: F.company._id }, 5),
    events: (await m.client.query(anyApi.events.forOrg, { orgId: t.orgId, paginationOpts: { numItems: 5, cursor: null } })).page.length,
    agentFilter: JSON.parse((await call('GET', 'records?object=opportunity&filter=amount&value=777777&limit=1')).text),
    exportFirst: await m.client.query(anyApi.csv.exportPage, { ...listArgs, cursor: null }),
    searchMs: await time(() => searchRecent(1)),
    agentSearchMs: null,
  };
  { const xs = []; for (let i = 0; i < 21; i++) xs.push((await call('GET', 'search?q=&object=opportunity&limit=1')).ms); baseline.agentSearchMs = +median(xs).toFixed(2); }

  // Three hidden deals with a distinctive amount, plus four ordinary ones.
  await addHidden(3, 777777, 'Secret Deal'); await addHidden(4);

  await check('R3-P1', 3, 'records.list (member, recent-first, 5 per page): adding unreadable rows does not change what the member sees', async () => {
    const after = await walk(anyApi.records.list, listArgs, 5);
    const out = { before: baseline.list.map(p => ({ n: p.n, done: p.done })), after: after.map(p => ({ n: p.n, done: p.done })), inferredHidden: after.length * 5 - after.reduce((s, p) => s + p.n, 0) - (5 - (after.at(-1).n || 0)) };
    assert.deepEqual(out.after, out.before, 'short pages reveal unreadable rows: ' + JSON.stringify(out)); return out;
  });
  await check('R3-P2', 3, 'records.list filtered on amount (member, 1 per page): a value held only by unreadable deals looks the same as a value nobody holds', async () => {
    const hit = await walk(anyApi.records.list, { ...listArgs, filter: { fieldId: F.amount._id, value: 777777 } }, 1);
    const miss = await walk(anyApi.records.list, { ...listArgs, filter: { fieldId: F.amount._id, value: 888888 } }, 1);
    const out = { hiddenValue: hit.map(p => ({ n: p.n, done: p.done })), missingValue: miss.map(p => ({ n: p.n, done: p.done })), beforeHiddenAdded: baseline.listByAmount.map(p => ({ n: p.n, done: p.done })), pagesCountHiddenDeals: hit.length - 1 };
    assert.deepEqual(out.hiddenValue, out.missingValue, 'value oracle: ' + JSON.stringify(out)); return out;
  });
  await check('R3-P3', 3, 'Agent REST /records filtered on amount (limit 1): hidden value vs missing value give the same body', async () => {
    const hit = await call('GET', 'records?object=opportunity&filter=amount&value=777777&limit=1'), miss = await call('GET', 'records?object=opportunity&filter=amount&value=888888&limit=1');
    const shape = r => { const b = JSON.parse(r.text); return { status: r.status, records: b.records?.length, cursor: b.cursor === null ? null : 'present' }; };
    let pages = 0, cursor = JSON.parse(hit.text).cursor; while (cursor && pages < 20) { pages++; cursor = JSON.parse((await call('GET', 'records?object=opportunity&filter=amount&value=777777&limit=1&cursor=' + encodeURIComponent(cursor))).text).cursor; }
    const out = { hiddenValue: shape(hit), missingValue: shape(miss), before: { records: baseline.agentFilter.records?.length, cursor: baseline.agentFilter.cursor === null ? null : 'present' }, followUpPagesForHiddenValue: pages };
    assert.deepEqual(out.hiddenValue, out.missingValue, 'value oracle: ' + JSON.stringify(out)); return out;
  });
  await check('R3-P4', 3, 'records.related (member, lookup opportunity.company -> readable Acme, 5 per page): unreadable linked deals do not change the pages', async () => {
    const after = await walk(anyApi.records.related, { orgId: t.orgId, recordId: acme, fieldId: F.company._id }, 5);
    const agentRel = JSON.parse((await call('GET', 'records/' + acme + '/related?field=opportunity.company')).text);
    const out = { before: baseline.related.map(p => ({ n: p.n, done: p.done })), after: after.map(p => ({ n: p.n, done: p.done })), agentRelatedCount: Array.isArray(agentRel) ? agentRel.length : agentRel };
    assert.deepEqual(out.after, out.before, 'short pages reveal unreadable linked rows: ' + JSON.stringify(out)); return out;
  });
  await check('R3-P5', 3, 'events.forOrg (member, first page of 5): events of unreadable records do not change the page', async () => {
    const after = await m.client.query(anyApi.events.forOrg, { orgId: t.orgId, paginationOpts: { numItems: 5, cursor: null } });
    const out = { beforeLen: baseline.events, afterLen: after.page.length, afterDone: after.isDone };
    assert.equal(out.afterLen, out.beforeLen, 'short page reveals hidden activity: ' + JSON.stringify(out)); return out;
  });
  await check('R3-P7', 3, 'Pagination cursors are opaque: a cursor that ends on an unreadable row does not contain its id, amount or title', async () => {
    const r = await m.client.query(anyApi.records.list, { ...listArgs, filter: { fieldId: F.amount._id, value: 777777 }, paginationOpts: { numItems: 1, cursor: null } });
    const secretIds = (await t.human.query(anyApi.records.list, { ...listArgs, filter: { fieldId: F.amount._id, value: 777777 }, paginationOpts: { numItems: 10, cursor: null } })).page.map(x => x._id);
    const c = r.continueCursor ?? '', decoded = [c, Buffer.from(c, 'base64').toString('latin1'), Buffer.from(c, 'base64url').toString('latin1')].join('|');
    const out = { cursorLength: c.length, cursorSample: c.slice(0, 40), containsId: secretIds.some(id => decoded.includes(id)), containsAmount: /777777/.test(decoded), containsTitle: /Secret/.test(decoded) };
    assert.ok(!out.containsId && !out.containsAmount && !out.containsTitle, JSON.stringify(out)); return out;
  });

  // Bulk: bring unreadable deals (all newer than "Mine Deal") to exactly 999.
  await addHidden(999 - hidden);
  await check('R3-P6', 3, 'CSV exportPage (member, 200 raw rows per page): unreadable rows do not change rows/done', async () => {
    const pages = []; let cursor = null; for (let i = 0; i < 10; i++) { const r = await m.client.query(anyApi.csv.exportPage, { ...listArgs, cursor }); pages.push({ rows: r.rows.length, done: r.done }); if (r.done) break; cursor = r.cursor; }
    const out = { before: [{ rows: baseline.exportFirst.rows.length, done: baseline.exportFirst.done }], after: pages };
    assert.deepEqual(out.after, out.before, 'export pages reveal hidden row count to within 200: ' + JSON.stringify(out)); return out;
  });
  const at999 = { member: (await searchRecent(1)).map(x => x.title), agent: JSON.parse((await call('GET', 'search?q=&object=opportunity&limit=1')).text).map?.(x => x.title ?? x.values?.name) };
  const timing999 = { member: await time(() => searchRecent(1)) };
  { const xs = []; for (let i = 0; i < 21; i++) xs.push((await call('GET', 'search?q=&object=opportunity&limit=1')).ms); timing999.agent = +median(xs).toFixed(2); }
  await addHidden(1);
  const at1000 = { member: (await searchRecent(1)).map(x => x.title), agent: JSON.parse((await call('GET', 'search?q=&object=opportunity&limit=1')).text).map?.(x => x.title ?? x.values?.name) };
  await check('R3-F1', 3, 'firstVisible scan cap: the member/agent recent-first search result does not depend on whether 999 or 1000 unreadable rows are newer than their own', async () => {
    const out = { with999Hidden: at999, with1000Hidden: at1000 };
    assert.deepEqual(out.with1000Hidden, out.with999Hidden, 'cap oracle: ' + JSON.stringify(out)); return out;
  });
  await check('R3-F2', 3, 'Timing: recent-first search (limit 1) returns the same single row in about the same time with 0 and 999 unreadable newer rows (median of 21, <5 ms and <2x)', async () => {
    const out = { memberMs: { hidden0: baseline.searchMs, hidden999: timing999.member }, agentMs: { hidden0: baseline.agentSearchMs, hidden999: timing999.agent } };
    for (const k of ['memberMs', 'agentMs']) { const { hidden0, hidden999 } = out[k]; assert.ok(hidden999 - hidden0 < 5 && hidden999 < 2 * hidden0, 'timing oracle: ' + JSON.stringify(out)); }
    return out;
  });
  await check('R3-F3', 3, 'Text search over many unreadable matches (agent, no object filter, and member) returns normally, never a platform-limit error that only unreadable rows could cause', async () => {
    const agentAll = await call('GET', 'search?q=' + encodeURIComponent('Deal') + '&limit=5'), agentObj = await call('GET', 'search?q=Deal&object=opportunity&limit=5');
    const member = await attempt(() => m.client.query(anyApi.records.search, { orgId: t.orgId, text: 'Deal', limit: 5 }));
    const out = { agentNoObject: agentAll.status + ' ' + agentAll.text.slice(0, 160), agentObject: agentObj.status + ' ' + agentObj.text.slice(0, 160), member: member.ok ? member.value.map(x => x.title) : member.error };
    assert.equal(agentAll.status, 200, JSON.stringify(out)); assert.equal(agentObj.status, 200, JSON.stringify(out)); assert.ok(member.ok, JSON.stringify(out)); return out;
  });
  return { results, hiddenRows: hidden, baseline };
}, { safetySim: true });
const pass = report.results.filter(r => r.status === 'PASS').length;
console.log(`R3 SUMMARY ${pass} PASS / ${report.results.length - pass} FAIL`);
writeFileSync(evidencePath('iv-r3.json'), JSON.stringify(report, null, 2) + '\n');
