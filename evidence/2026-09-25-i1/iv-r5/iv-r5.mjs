// IV round 5: attacks on I1 revision 4 (bb8e3ed): convex/authority/pending.ts (suggestion and inbox lists,
// agent /me counts), subscriptions, and a two-workspace timing control. Isolated local Convex (ports
// 3580/3581 via local-ports.patch), synthetic JWTs and data, no providers, spend or sends.
// Needs ops/authority/fixture-iv.ts (../iv-r2) and ops/authority/fixture-ivfive.ts (this folder).
// Usage: I1_EVIDENCE_DIR=<dir> node evidence/2026-09-25-i1/iv-r5/iv-r5.mjs
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { anyApi } from 'convex/server';
import { ConvexClient } from 'convex/browser';
import { withAuthority, evidencePath } from '../../../ops/authority/local.mjs';
import { tenant as makeTenant } from '../../../ops/authority/service-fixture.mjs';

const only = process.env.IV_ONLY ? new RegExp(process.env.IV_ONLY) : null;
const pause = ms => new Promise(r => setTimeout(r, ms));
const median = xs => +[...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)].toFixed(2);

const report = await withAuthority(async f => {
  const results = [];
  const check = async (id, claim, name, fn) => {
    if (only && !only.test(id)) return;
    try { const observed = await fn(); results.push({ id, claim, name, status: 'PASS', observed }); console.log('PASS', id, name); }
    catch (e) { results.push({ id, claim, name, status: 'FAIL', error: String(e?.message ?? e).slice(0, 20000) }); console.log('FAIL', id, name, '\n   ', String(e?.message ?? e).slice(0, 1500)); }
  };
  f.run('integrations/connections:registerProvider', { provider: 'fake', enabled: true });
  f.run('integrations/budgets:configure', { cap: 100000, maxConcurrent: 1000, maxPerRun: 1000, maxSteps: 5, maxRecipients: 100 });
  const rest = key => async (method, path, body) => { const s = performance.now(); const r = await fetch(f.site + '/api/v1/' + path, { method, headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const text = await r.text(); return { status: r.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })(), ms: performance.now() - s }; };

  // A workspace with: opportunity records a, b (readable to the restricted callers) and hidden ones;
  // member M scoped to [a, b]; scoped agent X with read+propose on [a, b]; a pool of proposers.
  const workspace = async label => {
    const t = await makeTenant(f, label);
    const objects = await t.human.query(anyApi.objects.list, { orgId: t.orgId }), o = objects.find(x => x.key === 'opportunity');
    const F = Object.fromEntries((await t.human.query(anyApi.objects.get, { orgId: t.orgId, objectId: o._id })).fields.map(x => [x.key, x]));
    const mk = name => t.human.mutation(anyApi.records.create, { orgId: t.orgId, objectId: o._id, values: { [F.name._id]: name } }, { skipQueue: true }).then(r => r.recordId);
    const a = await mk('Deal a'), b = await mk('Deal b'), hiddenRecs = []; for (let i = 0; i < 4; i++) hiddenRecs.push(await mk('Deal hidden ' + i));
    const subject = label + '-m-' + randomUUID(), mClient = f.client(subject), mUser = await mClient.mutation(anyApi.users.store, {});
    const inv = await t.human.mutation(anyApi.invites.create, { orgId: t.orgId, role: 'member' }); await mClient.mutation(anyApi.invites.accept, { token: inv.token });
    const mId = (await t.human.query(anyApi.orgs.members, { orgId: t.orgId })).find(m => m.user._id === mUser).member._id;
    const others = objects.filter(x => x.key !== 'opportunity').map(x => ({ objectId: x._id, records: 'all', fields: 'all' }));
    const setM = records => t.human.mutation(anyApi['authority/policies'].setMember, { orgId: t.orgId, memberId: mId, scopes: [{ objectId: o._id, records, fields: 'all' }, ...others], hiddenFieldIds: [] });
    await setM([a, b]);
    const fields = Object.values(F).map(x => x._id);
    const grant = (agentId, capability, records) => t.human.mutation(anyApi['authority/grants'].grant, { orgId: t.orgId, target: agentId, capability, scope: { kind: 'records', objectId: o._id, records, fields }, mode: 'direct', delegate: false, expiresAt: Date.now() + 3600000 });
    const scoped = async (name, grants) => { const ag = await t.human.action(anyApi.agents.createScoped, { orgId: t.orgId, name, origin: 'external' }); for (const [cap, recs] of grants) await grant(ag.agentId, cap, recs); return { ...ag, call: rest(ag.key), used: 0 }; };
    const X = await scoped('X', [['read', [a, b]], ['propose', [a, b]]]);
    const pool = []; for (let i = 0; i < 14; i++) pool.push(await scoped('p' + i, [['read', 'all'], ['propose', 'all']]));
    const notePool = []; for (let i = 0; i < 12; i++) notePool.push(await scoped('n' + i, []));
    let next = 0; const pick = list => { for (let i = 0; i < list.length; i++) { const p = list[(next + i) % list.length]; if (p.used < 110) { next = (next + i + 1) % list.length; p.used++; return p; } } throw new Error('pool exhausted'); };
    let seq = 0;
    const propose = async (record, by) => { const r = await (by ?? pick(pool)).call('POST', 'suggestions', { action: 'update', record, values: { amount: 1000 + seq++ }, reason: 'r' }); if (r.status !== 201) throw new Error('propose ' + r.status + ' ' + r.text.slice(0, 160)); return r.json.suggestion.id; };
    const hiddenSuggestions = async n => { for (let i = 0; i < n; i += 40) await Promise.all(Array.from({ length: Math.min(40, n - i) }, (_, j) => propose(hiddenRecs[(i + j) % hiddenRecs.length]))); };
    const hiddenNotes = async n => { for (let i = 0; i < n; i += 40) await Promise.all(Array.from({ length: Math.min(40, n - i) }, async () => { const r = await pick(notePool).call('POST', 'inbox', { text: 'private ' + seq++ }); if (r.status !== 201) throw new Error('inbox ' + r.status + ' ' + r.text.slice(0, 120)); })); };
    return { t, o, F, a, b, hiddenRecs, subject, mClient, mUser, mId, setM, grant, scoped, X, pool, propose, hiddenSuggestions, hiddenNotes, mk };
  };

  const W = await workspace('r5');
  const { t } = W;
  const mList = async (status) => (await W.mClient.query(anyApi.suggestions.list, { orgId: t.orgId, ...(status ? { status } : {}) })).map(r => r.suggestion._id);
  const xList = async (status) => (await W.X.call('GET', 'suggestions' + (status ? '?status=' + status : ''))).json.map(s => s.id);
  const xMe = async () => { const me = (await W.X.call('GET', 'me')).json; return [me.pendingSuggestions, me.pendingInbox]; };
  const ownerAll = async (status) => (await t.human.query(anyApi.suggestions.list, { orgId: t.orgId, ...(status ? { status } : {}) })).map(r => r.suggestion);

  // ---------- Suggestions ----------
  const sa1 = await W.propose(W.a), sb1 = await W.propose(W.b), sa2 = await W.propose(W.a);
  await W.hiddenSuggestions(5);
  const createSug = await W.pool[0].call('POST', 'suggestions', { action: 'create', object: 'opportunity', values: { name: 'new one' }, reason: 'r' }); W.pool[0].used++;
  await check('R5-A1', 3, 'Suggestion lists (member, agent) and agent /me return exactly the suggestions on readable records, newest first, and do not change when hidden suggestions are added', async () => {
    const expected = (await ownerAll()).filter(s => [W.a, W.b].includes(s.change.recordId)).map(s => s._id);
    const before = { member: await mList(), agent: await xList(), me: await xMe() };
    await W.hiddenSuggestions(60);
    const after = { member: await mList(), agent: await xList(), me: await xMe() };
    const out = { expected: expected.length, createSuggestionStatus: createSug.status, before: { member: before.member.length, agent: before.agent.length, me: before.me }, after: { member: after.member.length, agent: after.agent.length, me: after.me } };
    assert.deepEqual(before.member, expected, 'member ' + JSON.stringify(out)); assert.deepEqual(before.agent, expected, 'agent ' + JSON.stringify(out));
    assert.equal(before.me[0], expected.length, 'me ' + JSON.stringify(out)); assert.deepEqual(after, before, 'hidden suggestions changed the view ' + JSON.stringify(out));
    return out;
  });
  await check('R5-A2', 3, 'Status lists: after dismissing one readable and several hidden suggestions, the dismissed list shows only the readable one; pending drops it', async () => {
    const hiddenPending = (await ownerAll()).filter(s => W.hiddenRecs.includes(s.change.recordId)).slice(0, 5);
    await t.human.mutation(anyApi.suggestions.dismiss, { orgId: t.orgId, suggestionId: sb1 });
    for (const s of hiddenPending) await t.human.mutation(anyApi.suggestions.dismiss, { orgId: t.orgId, suggestionId: s._id });
    const out = { memberDismissed: await mList('dismissed'), agentDismissed: await xList('dismissed'), memberPending: (await mList()).length };
    assert.deepEqual(out.memberDismissed, [sb1], JSON.stringify(out)); assert.deepEqual(out.agentDismissed, [sb1], JSON.stringify(out)); assert.equal(out.memberPending, 2);
    return out;
  });
  await check('R5-A3', 3, 'Lost access: a member narrowed from [a,b] to [a], and an agent whose grant on b is revoked, stop seeing b\'s suggestions; a union of two list grants and a list+all grant pair behave as a union', async () => {
    const sb2 = await W.propose(W.b);
    await W.setM([W.a]); const memberAfterNarrow = await mList();
    const Y = await W.scoped('Y', [['read', [W.a]]]); const gB = await W.grant(Y.agentId, 'read', [W.b]);
    const yBoth = (await Y.call('GET', 'suggestions')).json.map(s => s.id);
    await t.human.mutation(anyApi['authority/grants'].revoke, { orgId: t.orgId, id: gB }); const yAfter = (await Y.call('GET', 'suggestions')).json.map(s => s.id);
    const Z = await W.scoped('Z', [['read', [W.a]], ['read', 'all']]); const zAll = (await Z.call('GET', 'suggestions')).json.length, ownerPending = (await ownerAll()).length;
    await W.setM([W.a, W.b]);
    const out = { memberAfterNarrow, yBoth, yAfter, zAll, ownerPending, ids: { sa1, sa2, sb2 } };
    assert.deepEqual(memberAfterNarrow, [sa2, sa1], JSON.stringify(out));
    assert.deepEqual(yBoth, [sb2, sa2, sa1], JSON.stringify(out)); assert.deepEqual(yAfter, [sa2, sa1], JSON.stringify(out));
    // Z reads every opportunity, so it sees every pending update suggestion on opportunity (not the create one: that has no record; it would need an 'all' scope, which Z has).
    assert.equal(zAll, ownerPending, JSON.stringify(out));
    return out;
  });

  // ---------- Inbox audiences ----------
  await check('R5-B1', 3, 'Inbox audiences: own, shared (org), private (author), legacy pre-freeze (no audience) and post-freeze no-audience items reach exactly the right readers (restricted member, scoped agent, shared-inbox agent, legacy pre-freeze agent, owner), and hidden notes change nothing', async () => {
    const shared1 = await t.human.mutation(anyApi.inbox.add, { orgId: t.orgId, text: 'shared one', shareWithAgents: true });
    const priv = await t.human.mutation(anyApi.inbox.add, { orgId: t.orgId, text: 'owner private', shareWithAgents: false });
    const S = await t.human.action(anyApi.agents.create, { orgId: t.orgId, name: 'S', grants: [{ action: 'update', objectKey: 'opportunity' }] });
    await t.human.mutation(anyApi.agents.setSharedInbox, { orgId: t.orgId, agentId: S.agentId, enabled: true });
    const Q = await t.human.action(anyApi.agents.create, { orgId: t.orgId, name: 'Q-legacy', grants: [{ action: 'update', objectKey: 'opportunity' }] });
    f.run('authorityFixtureIv:makeLegacy', { agentId: Q.agentId, grants: [{ action: 'update', objectKey: 'opportunity' }] });
    const legacyNote = (await W.pool[1].call('POST', 'inbox', { text: 'legacy pre-freeze' })).json.id; W.pool[1].used++;
    f.run('authorityFixtureIvfive:clearAudience', { id: legacyNote });
    await pause(5); f.run('authorityFixtureIvfive:setFreeze', { orgId: t.orgId, at: Date.now() }); await pause(5);
    const lateNote = (await W.pool[2].call('POST', 'inbox', { text: 'no audience after freeze' })).json.id; W.pool[2].used++;
    f.run('authorityFixtureIvfive:clearAudience', { id: lateNote });
    const shared2 = await t.human.mutation(anyApi.inbox.add, { orgId: t.orgId, text: 'shared two', shareWithAgents: true });
    await W.X.call('POST', 'inbox', { text: 'X own' }); await rest(S.key)('POST', 'inbox', { text: 'S own' }); await rest(Q.key)('POST', 'inbox', { text: 'Q own' });
    await W.mClient.mutation(anyApi.inbox.add, { orgId: t.orgId, text: 'M own' });
    const views = async () => ({
      member: (await W.mClient.query(anyApi.inbox.list, { orgId: t.orgId })).map(i => i.text),
      X: (await W.X.call('GET', 'inbox')).json.map(i => i.text), Xme: (await xMe())[1],
      S: (await rest(S.key)('GET', 'inbox')).json.map(i => i.text), Sme: (await rest(S.key)('GET', 'me')).json.pendingInbox,
      Q: (await rest(Q.key)('GET', 'inbox')).json.map(i => i.text),
      owner: (await t.human.query(anyApi.inbox.list, { orgId: t.orgId })).map(i => i.text).filter(x => !x.startsWith('private')),
    });
    const before = await views(); await W.hiddenNotes(40); const after = await views();
    const sharedSet = ['shared one', 'legacy pre-freeze', 'shared two'];
    const expected = { member: ['M own'], X: ['X own'], Xme: 1, S: [...sharedSet, 'S own'], Sme: 4, Q: [...sharedSet, 'Q own'], owner: ['shared one', 'owner private', 'legacy pre-freeze', 'no audience after freeze', 'shared two', 'X own', 'S own', 'Q own', 'M own'] };
    const out = { before, after, expected, sharedReader: { S: true, Q: 'legacy, created before the moved freeze' }, ids: { shared1, priv, shared2 } };
    assert.deepEqual(before, expected, JSON.stringify(out)); assert.deepEqual(after, before, 'hidden notes changed a view ' + JSON.stringify(out));
    return out;
  });

  // ---------- Subscriptions ----------
  await check('R5-C1', 3, 'Open subscriptions of the record-scoped member (suggestions, inbox, records.list, events feed, search, today) receive no update when only hidden rows change, and do update on a visible change', async () => {
    const ws = new ConvexClient(f.url, { logger: false }); ws.setAuth(async () => f.token(W.subject));
    const subs = {
      suggestions: [anyApi.suggestions.list, { orgId: t.orgId }], inbox: [anyApi.inbox.list, { orgId: t.orgId }],
      list: [anyApi.records.list, { orgId: t.orgId, objectId: W.o._id, paginationOpts: { numItems: 10, cursor: null } }],
      events: [anyApi.events.forOrg, { orgId: t.orgId, paginationOpts: { numItems: 10, cursor: null } }],
      search: [anyApi.records.search, { orgId: t.orgId, text: 'Deal', limit: 5 }], today: [anyApi.today.get, { orgId: t.orgId, today: Date.now() }],
    };
    const counts = Object.fromEntries(Object.keys(subs).map(k => [k, 0])), stops = [];
    for (const [k, [fn, args]] of Object.entries(subs)) stops.push(ws.onUpdate(fn, args, () => { counts[k]++; }, e => { counts[k + 'Error'] = String(e).slice(0, 200); }));
    await pause(2500); const initial = { ...counts };
    // Hidden-only changes: new hidden deals, edits to hidden deals, suggestions on hidden deals, other agents' private notes, dismissals of hidden suggestions.
    for (let i = 0; i < 5; i++) await W.mk('Deal hidden sub ' + i);
    for (const id of W.hiddenRecs) await t.human.mutation(anyApi.records.update, { orgId: t.orgId, recordId: id, values: { [W.F.amount._id]: 424242 } });
    await W.hiddenSuggestions(10); await W.hiddenNotes(10);
    const hiddenPending = (await ownerAll()).filter(s => W.hiddenRecs.includes(s.change.recordId)).slice(0, 3);
    for (const s of hiddenPending) await t.human.mutation(anyApi.suggestions.dismiss, { orgId: t.orgId, suggestionId: s._id });
    await pause(2500); const afterHidden = { ...counts };
    await W.propose(W.a); await W.mClient.mutation(anyApi.inbox.add, { orgId: t.orgId, text: 'M visible' });
    await t.human.mutation(anyApi.records.update, { orgId: t.orgId, recordId: W.a, values: { [W.F.amount._id]: 7 } });
    await pause(2500); const afterVisible = { ...counts };
    for (const s of stops) s(); await ws.close();
    const delta = (x, y) => Object.fromEntries(Object.keys(subs).map(k => [k, y[k] - x[k]]));
    const out = { initial, hiddenOnlyUpdates: delta(initial, afterHidden), visibleUpdates: delta(afterHidden, afterVisible), errors: Object.fromEntries(Object.entries(counts).filter(([k]) => k.endsWith('Error'))) };
    assert.deepEqual(Object.values(out.hiddenOnlyUpdates).filter(n => n !== 0), [], 'hidden change pushed an update: ' + JSON.stringify(out));
    for (const k of ['suggestions', 'inbox', 'list', 'events']) assert.ok(out.visibleUpdates[k] > 0, 'subscription not live: ' + JSON.stringify(out));
    return out;
  });

  // ---------- Two-workspace timing control ----------
  await check('R5-T1', 3, 'Timing: two identical workspaces sampled alternately; only A gets 1000 hidden suggestions and 1000 hidden private notes. Median latency of member suggestions/inbox lists and agent /suggestions, /inbox, /me stays equal (within 2 ms or 30%)', async () => {
    const A = await workspace('tA'), B = await workspace('tB');
    const probes = w => ({
      memberSuggestions: () => w.mClient.query(anyApi.suggestions.list, { orgId: w.t.orgId }), memberInbox: () => w.mClient.query(anyApi.inbox.list, { orgId: w.t.orgId }),
      agentSuggestions: () => w.X.call('GET', 'suggestions'), agentInbox: () => w.X.call('GET', 'inbox'), agentMe: () => w.X.call('GET', 'me'),
    });
    const stage = async () => { const out = { A: {}, B: {} }; const xs = { A: {}, B: {} };
      for (let i = 0; i < 21; i++) for (const [n, w] of [['A', A], ['B', B]]) {
        // A visible write in each read range, so every timed call is a real execution, not a cached result.
        await w.propose(w.a, w.X); w.X.used++; await w.X.call('POST', 'inbox', { text: 'X ' + i }); await w.mClient.mutation(anyApi.inbox.add, { orgId: w.t.orgId, text: 'M ' + i });
        for (const [k, fn] of Object.entries(probes(w))) { const s = performance.now(); await fn(); (xs[n][k] ??= []).push(performance.now() - s); }
      }
      for (const n of ['A', 'B']) for (const k of Object.keys(xs[n])) out[n][k] = median(xs[n][k]); return out; };
    const before = await stage();
    await A.hiddenSuggestions(1000); await A.hiddenNotes(1000);
    await pause(61000); for (const w of [A, B]) w.X.used = 0; // refill X's write bucket for the second stage
    const after = await stage();
    const out = { before, after1000HiddenInA: after };
    for (const k of Object.keys(after.A)) { const a = after.A[k], b = after.B[k]; assert.ok(Math.abs(a - b) < 2 || Math.abs(a - b) / b < 0.3, `${k}: A ${a} vs B ${b} ` + JSON.stringify(out)); }
    return out;
  });
  return { results };
}, { safetySim: true });
const pass = report.results.filter(r => r.status === 'PASS').length;
console.log(`R5 SUMMARY ${pass} PASS / ${report.results.length - pass} FAIL`);
writeFileSync(evidencePath('iv-r5.json'), JSON.stringify(report, null, 2) + '\n');
