// IV round 4: attacks on I1 revision 3 (87d4c10): the explicit-list read path, its cursors, sort/filter
// equivalence with the Convex index path, the merged events feed, other reader kinds, and the residual
// suggestion/inbox scan cap and timing. Isolated local Convex (ports 3570/3571 via local-ports.patch),
// synthetic JWTs and data, no providers, spend or sends. Needs ops/authority/fixture-iv.ts from ../iv-r2.
// Usage: I1_EVIDENCE_DIR=<dir> node evidence/2026-09-25-i1/iv-r4/iv-r4.mjs
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { anyApi } from 'convex/server';
import { withAuthority, evidencePath } from '../../../ops/authority/local.mjs';
import { tenant as makeTenant } from '../../../ops/authority/service-fixture.mjs';

const only = process.env.IV_ONLY ? new RegExp(process.env.IV_ONLY) : null;
const errText = e => String(e?.data ? JSON.stringify(e.data) : e?.message ?? e);
const attempt = async fn => { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: errText(e).replace(/\[Request ID: [^\]]+\]/g, '[req]').slice(0, 240) }; } };
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const report = await withAuthority(async f => {
  const results = [];
  const check = async (id, claim, name, fn) => {
    if (only && !only.test(id)) return;
    try { const observed = await fn(); results.push({ id, claim, name, status: 'PASS', observed }); console.log('PASS', id, name); }
    catch (e) { results.push({ id, claim, name, status: 'FAIL', error: String(e?.message ?? e).slice(0, 20000) }); console.log('FAIL', id, name, '\n   ', String(e?.message ?? e).slice(0, 1200)); }
  };
  f.run('integrations/connections:registerProvider', { provider: 'fake', enabled: true });
  f.run('integrations/budgets:configure', { cap: 100000, maxConcurrent: 1000, maxPerRun: 1000, maxSteps: 5, maxRecipients: 100 });
  const rest = key => async (method, path, body) => { const s = performance.now(); const r = await fetch(f.site + '/api/v1/' + path, { method, headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const text = await r.text(); return { status: r.status, text, ms: performance.now() - s }; };
  const invite = async (t, role, label) => { const client = f.client(label + '-' + randomUUID()), userId = await client.mutation(anyApi.users.store, {}); const inv = await t.human.mutation(anyApi.invites.create, { orgId: t.orgId, role }); await client.mutation(anyApi.invites.accept, { token: inv.token }); return { client, userId }; };
  const memberOf = async (t, userId) => (await t.human.query(anyApi.orgs.members, { orgId: t.orgId })).find(m => m.user._id === userId).member;
  const objectOf = async (t, key) => { const objects = await t.human.query(anyApi.objects.list, { orgId: t.orgId }), o = objects.find(x => x.key === key), d = await t.human.query(anyApi.objects.get, { orgId: t.orgId, objectId: o._id }); return { object: o, fields: Object.fromEntries(d.fields.map(x => [x.key, x])), objects }; };
  const grant = (t, agentId, capability, o, records, fields) => t.human.mutation(anyApi['authority/grants'].grant, { orgId: t.orgId, target: agentId, capability, scope: { kind: 'records', objectId: o.object._id, records, fields: fields ?? Object.values(o.fields).map(x => x._id) }, mode: 'direct', delegate: false, expiresAt: Date.now() + 3600000 });

  const t = await makeTenant(f, 'r4');
  const opp = await objectOf(t, 'opportunity'), co = await objectOf(t, 'company'), F = opp.fields;
  const acme = (await t.human.mutation(anyApi.records.create, { orgId: t.orgId, objectId: co.object._id, values: { [co.fields.name._id]: 'Acme Readable' } })).recordId;
  const newOpp = (name, amount, extra = {}) => t.human.mutation(anyApi.records.create, { orgId: t.orgId, objectId: opp.object._id, values: { [F.name._id]: name, ...(amount === undefined ? {} : { [F.amount._id]: amount }), [F.company._id]: acme, ...extra } }, { skipQueue: true }).then(r => r.recordId);
  // Readable set for the record-scoped member: tricky sort keys (ties, missing, negative, fractional, huge;
  // case, accents, digits-as-text, an astral-plane emoji vs U+FFFD, which UTF-16 and code-point order disagree on).
  const readableSpec = [['b', 5], ['B', 5], ['a', undefined], ['é', 0], ['Z', -1], ['😀x', 1e9], ['�y', 2.5], ['10', 5], ['9', 7]];
  const listed = []; for (const [name, amount] of readableSpec) { listed.push(await newOpp(name, amount)); await newOpp('hid ' + name, amount); }
  const others = []; for (let i = 0; i < 6; i++) others.push(await newOpp(['c', 'A', '😀', '11', 'b', 'è'][i], [5, 3, undefined, 5, 0, 8][i]));
  const allObjects = opp.objects.filter(o => o.key !== 'opportunity').map(o => ({ objectId: o._id, records: 'all', fields: 'all' }));
  const m = await invite(t, 'member', 'listed');
  const mId = (await memberOf(t, m.userId))._id;
  const setScopes = scopes => t.human.mutation(anyApi['authority/policies'].setMember, { orgId: t.orgId, memberId: mId, scopes, hiddenFieldIds: [] });
  await setScopes([{ objectId: opp.object._id, records: listed, fields: 'all' }, ...allObjects]);
  const agent = await t.human.action(anyApi.agents.createScoped, { orgId: t.orgId, name: 'r4-listed', origin: 'external' });
  await grant(t, agent.agentId, 'read', opp, listed); await grant(t, agent.agentId, 'read', co, 'all');
  const call = rest(agent.key);
  const isHidden = id => !listed.includes(id);
  const listArgs = { orgId: t.orgId, objectId: opp.object._id };
  const walk = async (client, fn, args, numItems) => { const ids = [], shape = []; let cursor = null; for (let i = 0; i < 80; i++) { const r = await client.query(fn, { ...args, paginationOpts: { numItems, cursor } }); ids.push(...r.page.map(x => x._id)); shape.push([r.page.length, r.isDone]); if (r.isDone) break; cursor = r.continueCursor; } return { ids, shape }; };

  // ---------- C3: sort/filter results equal the Convex index order restricted to readable rows ----------
  await check('R4-C3', 3, 'Explicit-list path returns exactly the rows and order the Convex index path gives for the same query, restricted to readable rows (member records.list and agent GET /records)', async () => {
    const cases = { default: {}, amountAsc: { sort: { fieldId: F.amount._id, direction: 'asc' } }, amountDesc: { sort: { fieldId: F.amount._id, direction: 'desc' } }, nameAsc: { sort: { fieldId: F.name._id, direction: 'asc' } }, nameDesc: { sort: { fieldId: F.name._id, direction: 'desc' } }, amountEq5: { filter: { fieldId: F.amount._id, value: 5 } }, amountEq0: { filter: { fieldId: F.amount._id, value: 0 } }, amountEqMinus0: { filter: { fieldId: F.amount._id, value: -0 } }, amountEqStr5: { filter: { fieldId: F.amount._id, value: '5' } }, nameEqb: { filter: { fieldId: F.name._id, value: 'b' } }, amount5Desc: { sort: { fieldId: F.amount._id, direction: 'desc' }, filter: { fieldId: F.amount._id, value: 5 } } };
    const out = {}, differ = [];
    for (const [k, extra] of Object.entries(cases)) {
      const owner = await walk(t.human, anyApi.records.list, { ...listArgs, ...extra }, 50), member = await walk(m.client, anyApi.records.list, { ...listArgs, ...extra }, 3);
      const expected = owner.ids.filter(id => !isHidden(id)), name = id => readableSpec[listed.indexOf(id)]?.[0] ?? '?';
      out[k] = { expected: expected.map(name).join(' '), member: member.ids.map(name).join(' ') };
      if (JSON.stringify(expected) !== JSON.stringify(member.ids)) differ.push(k);
    }
    // Agent REST: same queries by field key.
    for (const [k, q] of Object.entries({ agentAmountAsc: 'sort=amount&direction=asc', agentNameDesc: 'sort=name&direction=desc', agentAmountEq5: 'filter=amount&value=5' })) {
      const ids = []; let cursor = null; for (let i = 0; i < 20; i++) { const r = JSON.parse((await call('GET', 'records?object=opportunity&limit=2&' + q + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''))).text); ids.push(...r.records.map(x => x.id)); if (!r.cursor) break; cursor = r.cursor; }
      const ownerCase = k === 'agentAmountAsc' ? cases.amountAsc : k === 'agentNameDesc' ? cases.nameDesc : cases.amountEq5;
      const expected = (await walk(t.human, anyApi.records.list, { ...listArgs, ...ownerCase }, 50)).ids.filter(id => !isHidden(id));
      out[k] = { expected: expected.length, agent: ids.length, same: JSON.stringify(expected) === JSON.stringify(ids) };
      if (!out[k].same) differ.push(k);
    }
    assert.deepEqual(differ, [], 'order/filter differs from the index path: ' + JSON.stringify(Object.fromEntries(differ.map(k => [k, out[k]])))); return out;
  });

  // ---------- baseline snapshots of every paged surface for the listed member, before extra hidden rows ----------
  const eventsWalk = async (client, n) => walk(client, anyApi.events.forOrg, { orgId: t.orgId }, n);
  const surfaces = async () => ({
    list: (await walk(m.client, anyApi.records.list, listArgs, 4)).shape,
    listFiltered: (await walk(m.client, anyApi.records.list, { ...listArgs, filter: { fieldId: F.amount._id, value: 777777 } }, 1)).shape,
    related: (await walk(m.client, anyApi.records.related, { orgId: t.orgId, recordId: acme, fieldId: F.company._id }, 4)).shape,
    events: (await eventsWalk(m.client, 4)).shape,
    agentFilter: JSON.parse((await call('GET', 'records?object=opportunity&filter=amount&value=777777&limit=1')).text),
    csv: await (async () => { const r = await m.client.query(anyApi.csv.exportPage, { ...listArgs, cursor: null }); return [r.rows.length, r.done]; })(),
  });
  const cursorProbes = async () => {
    const q = cursor => attempt(() => m.client.query(anyApi.records.list, { ...listArgs, paginationOpts: { numItems: 3, cursor } })).then(r => r.ok ? { n: r.value.page.length, done: r.value.isDone, next: r.value.continueCursor, hiddenIds: r.value.page.filter(x => isHidden(x._id)).length } : r.error);
    const ownerCursor = (await t.human.query(anyApi.records.list, { ...listArgs, paginationOpts: { numItems: 3, cursor: null } })).continueCursor;
    const out = {};
    for (const c of ['list:0', 'list:3', 'list:9', 'list:999999', 'list:99999999999999999999999999', 'list:-1', 'list:', 'list:1.5', 'list:0x10', 'list: 1', 'LIST:1', 'events:start:']) out[c] = await q(c);
    out.ownerConvexCursor = await q(ownerCursor);
    out.endCursorBeyond = await attempt(() => m.client.query(anyApi.records.list, { ...listArgs, paginationOpts: { numItems: 3, cursor: 'list:2', endCursor: 'list:999' } })).then(r => r.ok ? { n: r.value.page.length, done: r.value.isDone, hidden: r.value.page.filter(x => isHidden(x._id)).length } : r.error);
    out.agentCursors = {}; for (const c of ['list:1', 'list:99999', 'list:-5', 'garbage']) { const r = await call('GET', 'records?object=opportunity&limit=2&cursor=' + encodeURIComponent(c)); out.agentCursors[c] = r.status + ' ' + r.text.replace(/"id":"[^"]+"/g, '"id":"<id>"').replace(/"(createdAt|updatedAt)":[\d.]+/g, '"$1":<t>').replace(/"ref":"[^"]+"/g, '"ref":"<r>"').slice(0, 90); }
    const evs = (await t.human.query(anyApi.events.forOrg, { orgId: t.orgId, paginationOpts: { numItems: 500, cursor: null } })).page, hiddenEvent = evs.find(e => e.objectId === opp.object._id && isHidden(e.recordId))._id;
    const eq = cursor => attempt(() => m.client.query(anyApi.events.forOrg, { orgId: t.orgId, paginationOpts: { numItems: 3, cursor } })).then(r => r.ok ? { n: r.value.page.length, done: r.value.isDone } : r.error);
    out.events = { hiddenSeen: await eq('events:start:' + hiddenEvent), randomSeen: await eq('events:start:zzzz'), farFuture: await eq('events:99999999999999:'), zero: await eq('events:0:'), negative: await eq('events:-5:'), exp: await eq('events:1e20:'), garbage: await eq('xyz'), listCursor: await eq('list:3') };
    return out;
  };
  const before = await surfaces(), cursorsBefore = await cursorProbes();

  // Unreadable rows: deals (3 at amount 777777), their events, links to Acme.
  for (let i = 0; i < 3; i++) await newOpp('Secret ' + i, 777777); for (let i = 0; i < 6; i++) await newOpp('Hidden ' + i, 1234);
  const after = await surfaces(), cursorsAfter = await cursorProbes();

  await check('R4-P', 3, 'Every paged surface (list, filtered list, related, events feed, agent filter, CSV) looks identical before and after unreadable rows are added', async () => {
    const out = { before, after };
    assert.deepEqual(after, before, 'hidden-row effect: ' + JSON.stringify(out)); return out;
  });
  await check('R4-C1', 3, 'Forged, out-of-range, malformed and foreign cursors (list and events) behave the same with and without unreadable rows and never return an unreadable row', async () => {
    const strip = o => JSON.parse(JSON.stringify(o).replace(/"next":"[^"]*"/g, '"next":"<c>"'));
    const out = { before: strip(cursorsBefore), after: strip(cursorsAfter) };
    const anyHidden = JSON.stringify(cursorsAfter).match(/"hidden(Ids)?":[1-9]/);
    assert.ok(!anyHidden, 'unreadable row returned: ' + JSON.stringify(out));
    // The owner's Convex cursor legitimately changes when rows change; compare everything else.
    delete out.before.ownerConvexCursor; delete out.after.ownerConvexCursor;
    assert.deepEqual(out.after, out.before, 'cursor outcome depends on hidden rows: ' + JSON.stringify(out)); return { ...out, ownerCursorBefore: strip(cursorsBefore).ownerConvexCursor, ownerCursorAfter: strip(cursorsAfter).ownerConvexCursor };
  });
  await check('R4-C2', 3, 'Scope switch mid-paging: a list cursor on the index path, and an index cursor on the list path, are refused (fail closed) and reveal nothing', async () => {
    const first = await m.client.query(anyApi.records.list, { ...listArgs, paginationOpts: { numItems: 3, cursor: null } });
    await setScopes([{ objectId: opp.object._id, records: 'all', fields: 'all' }, ...allObjects]);
    const widened = await attempt(() => m.client.query(anyApi.records.list, { ...listArgs, paginationOpts: { numItems: 3, cursor: first.continueCursor } }));
    const convexCursor = (await m.client.query(anyApi.records.list, { ...listArgs, paginationOpts: { numItems: 3, cursor: null } })).continueCursor;
    const evCursorAll = (await m.client.query(anyApi.events.forOrg, { orgId: t.orgId, paginationOpts: { numItems: 3, cursor: null } })).continueCursor;
    await setScopes([{ objectId: opp.object._id, records: listed, fields: 'all' }, ...allObjects]);
    const narrowed = await attempt(() => m.client.query(anyApi.records.list, { ...listArgs, paginationOpts: { numItems: 3, cursor: convexCursor } }));
    const evNarrowed = await attempt(() => m.client.query(anyApi.events.forOrg, { orgId: t.orgId, paginationOpts: { numItems: 3, cursor: evCursorAll } }));
    const out = { listCursorOnIndexPath: widened.ok ? { n: widened.value.page.length } : widened.error, indexCursorOnListPath: narrowed.ok ? { n: narrowed.value.page.length, hidden: narrowed.value.page.filter(x => isHidden(x._id)).length } : narrowed.error, indexEventsCursorOnMerge: evNarrowed.ok ? { n: evNarrowed.value.page.length } : evNarrowed.error };
    assert.ok(!narrowed.ok || narrowed.value.page.every(x => !isHidden(x._id)), JSON.stringify(out));
    assert.ok(!widened.ok && !narrowed.ok && !evNarrowed.ok, 'expected refusal: ' + JSON.stringify(out)); return out;
  });

  // ---------- C4: merged events feed equals the full feed restricted to what the member may see ----------
  await check('R4-C4', 3, 'Merged events feed (pages of 3): no duplicates, no omissions, same newest-first order as the org index restricted to readable records; including a multi-event transaction (delete that clears references)', async () => {
    const gone = await newOpp('Gone', 1); await setScopes([{ objectId: opp.object._id, records: [...listed, gone], fields: 'all' }, ...allObjects]);
    // A readable company referenced by several deals, deleted: one transaction writes many events.
    const tmpCo = (await t.human.mutation(anyApi.records.create, { orgId: t.orgId, objectId: co.object._id, values: { [co.fields.name._id]: 'Temp Co' } })).recordId;
    for (const id of [listed[0], listed[1], others[0]]) await t.human.mutation(anyApi.records.update, { orgId: t.orgId, recordId: id, values: { [F.company._id]: tmpCo } });
    await t.human.mutation(anyApi.records.remove, { orgId: t.orgId, recordId: tmpCo }); await t.human.mutation(anyApi.records.remove, { orgId: t.orgId, recordId: gone });
    const full = await walk(t.human, anyApi.events.forOrg, { orgId: t.orgId }, 1000);
    const evs = await t.human.query(anyApi.events.forOrg, { orgId: t.orgId, paginationOpts: { numItems: 1000, cursor: null } });
    const oppId = opp.object._id, visible = new Set([...listed, gone]);
    const expected = evs.page.filter(e => e.objectId !== oppId || visible.has(e.recordId)).map(e => e._id);
    const out = {}; for (const n of [1, 3, 7]) { const w = await eventsWalk(m.client, n); out['pages' + n] = { got: w.ids.length, expected: expected.length, duplicates: w.ids.length - new Set(w.ids).size, sameOrder: JSON.stringify(w.ids) === JSON.stringify(expected), pages: w.shape.length }; }
    const ties = evs.page.reduce((acc, e, i, a) => acc + (i && a[i - 1]._creationTime === e._creationTime ? 1 : 0), 0);
    out.equalCreationTimes = ties; out.fullFeed = full.ids.length;
    for (const v of Object.values(out)) if (typeof v === 'object') assert.ok(v.sameOrder && v.duplicates === 0, JSON.stringify(out));
    return out;
  });

  // ---------- C5: other reader kinds meet no hidden-row effects ----------
  await check('R4-C5', 3, 'Other reader kinds: field-masked (records all), mixed scopes on one object, two list scopes with different fields, no scope on an object, legacy agent: paged surfaces unchanged by rows they cannot read; hidden-field filters refused identically', async () => {
    const kinds = {
      fieldMasked: { scopes: undefined, hidden: [F.amount._id] },
      mixed: { scopes: [{ objectId: opp.object._id, records: 'all', fields: [F.name._id, F.company._id] }, { objectId: opp.object._id, records: [listed[0]], fields: 'all' }, ...allObjects], hidden: [] },
      twoLists: { scopes: [{ objectId: opp.object._id, records: [listed[0], listed[1]], fields: 'all' }, { objectId: opp.object._id, records: [listed[2], listed[3]], fields: [F.name._id] }, ...allObjects], hidden: [] },
      noOpportunity: { scopes: allObjects, hidden: [] },
    };
    const out = {};
    for (const [k, spec] of Object.entries(kinds)) {
      const u = await invite(t, 'member', k), uid = (await memberOf(t, u.userId))._id;
      await t.human.mutation(anyApi['authority/policies'].setMember, { orgId: t.orgId, memberId: uid, scopes: spec.scopes, hiddenFieldIds: spec.hidden });
      const snap = async () => ({
        list: await attempt(() => walk(u.client, anyApi.records.list, listArgs, 4).then(w => w.shape)),
        events: (await walk(u.client, anyApi.events.forOrg, { orgId: t.orgId }, 5)).shape,
        filterAmount777: await attempt(() => u.client.query(anyApi.records.list, { ...listArgs, filter: { fieldId: F.amount._id, value: 777777 }, paginationOpts: { numItems: 1, cursor: null } }).then(r => [r.page.length, r.isDone])),
        filterAmount888: await attempt(() => u.client.query(anyApi.records.list, { ...listArgs, filter: { fieldId: F.amount._id, value: 888888 }, paginationOpts: { numItems: 1, cursor: null } }).then(r => [r.page.length, r.isDone])),
        filterNameSecret: await attempt(() => u.client.query(anyApi.records.list, { ...listArgs, filter: { fieldId: F.name._id, value: 'Secret 0' }, paginationOpts: { numItems: 1, cursor: null } }).then(r => [r.page.length, r.isDone])),
        search: await attempt(() => u.client.query(anyApi.records.search, { orgId: t.orgId, text: 'Secret', limit: 3 }).then(r => r.length)),
        csv: await attempt(() => u.client.query(anyApi.csv.exportPage, { ...listArgs, cursor: null }).then(r => [r.rows.length, r.done])),
      });
      const b = await snap(); await newOpp('Secret ' + k, 777777); const a = await snap();
      // Readers who can read every opportunity will legitimately see the new row; only readers who cannot must see no change.
      const seesAll = k === 'fieldMasked' || k === 'mixed';
      out[k] = { before: b, after: a, seesAll };
      if (!seesAll) assert.deepEqual(a, b, k + ': ' + JSON.stringify(out[k]));
      else { assert.deepEqual(a.filterAmount777, b.filterAmount777, k + ' amount filter: ' + JSON.stringify(out[k])); assert.equal(JSON.stringify(a.filterAmount777), JSON.stringify(a.filterAmount888), k + ' hidden-field filter differs: ' + JSON.stringify(out[k])); }
    }
    // Legacy agent: pre-I1 grant model, reads every pre-freeze object.
    const legacy = await t.human.action(anyApi.agents.create, { orgId: t.orgId, name: 'legacy', grants: [{ action: 'update', objectKey: 'opportunity' }] });
    f.run('authorityFixtureIv:makeLegacy', { agentId: legacy.agentId, grants: [{ action: 'update', objectKey: 'opportunity' }] });
    const lr = rest(legacy.key), lp = async () => { const r = JSON.parse((await lr('GET', 'records?object=opportunity&limit=5')).text); return [r.records.length, !!r.cursor]; };
    out.legacyAgent = { firstPage: await lp() };
    assert.equal(out.legacyAgent.firstPage[0], 5, JSON.stringify(out.legacyAgent));
    return out;
  });

  // ---------- Residual: suggestion and inbox lists (1000-row scan cap and timing) ----------
  await check('R4-S', 3, 'Residual (disclosed): suggestion and inbox lists. Measures the 1000-row cap and uncached timing against pending items the caller cannot see', async () => {
    const pool = []; for (let i = 0; i < 24; i++) { const a = await t.human.action(anyApi.agents.createScoped, { orgId: t.orgId, name: 'pool' + i, origin: 'external' }); await grant(t, a.agentId, 'read', opp, 'all'); await grant(t, a.agentId, 'propose', opp, 'all'); pool.push({ call: rest(a.key), used: 0 }); }
    const hiddenTarget = await newOpp('Hidden target', 1);
    let hiddenSuggestions = 0, next = 0;
    const pick = () => { for (let i = 0; i < pool.length; i++) { const p = pool[(next + i) % pool.length]; if (p.used < 110) { next = (next + i + 1) % pool.length; p.used++; return p; } } throw new Error('pool exhausted'); };
    const addSuggestions = async n => { for (let i = 0; i < n; i += 40) await Promise.all(Array.from({ length: Math.min(40, n - i) }, async () => { const r = await pick().call('POST', 'suggestions', { action: 'update', record: hiddenTarget, values: { amount: 1000 + hiddenSuggestions++ }, reason: 'r' }); if (r.status !== 201) throw new Error('propose ' + r.status + ' ' + r.text.slice(0, 120)); })); };
    const mine = await pick().call('POST', 'suggestions', { action: 'update', record: listed[0], values: { amount: 42 }, reason: 'mine' }); assert.equal(mine.status, 201, mine.text);
    await grant(t, agent.agentId, 'propose', opp, listed);
    const memberSees = async () => (await m.client.query(anyApi.suggestions.list, { orgId: t.orgId })).length;
    const agentSees = async () => JSON.parse((await call('GET', 'suggestions')).text).length;
    const sample = async n => { const mem = [], ag = []; for (let i = 0; i < n; i++) { await addSuggestions(1); let s = performance.now(); await memberSees(); mem.push(performance.now() - s); await addSuggestions(1); ag.push((await call('GET', 'suggestions')).ms); } return { hidden: hiddenSuggestions, memberMs: +median(mem).toFixed(2), agentMs: +median(ag).toFixed(2) }; };
    await addSuggestions(40); const low = await sample(20);
    await addSuggestions(940 - hiddenSuggestions); const high = await sample(20);
    await addSuggestions(999 - hiddenSuggestions); const at999 = { member: await memberSees(), agent: await agentSees(), hidden: hiddenSuggestions };
    await addSuggestions(1); const at1000 = { member: await memberSees(), agent: await agentSees(), hidden: hiddenSuggestions };
    // Inbox: other agents' private notes are the hidden rows. Oldest first, so hidden notes must precede the caller's.
    const inboxPool = []; for (let i = 0; i < 12; i++) { const a = await t.human.action(anyApi.agents.createScoped, { orgId: t.orgId, name: 'ipool' + i, origin: 'external' }); inboxPool.push({ call: rest(a.key), used: 0 }); }
    let notes = 0; const addNotes = async n => { for (let i = 0; i < n; i += 40) await Promise.all(Array.from({ length: Math.min(40, n - i) }, async (_, j) => { const p = inboxPool[(notes + j) % inboxPool.length]; p.used++; const r = await p.call('POST', 'inbox', { text: 'private ' + (notes + j) }); if (r.status !== 201) throw new Error('inbox ' + r.status + ' ' + r.text.slice(0, 100)); })); notes += n; };
    const early = await t.human.action(anyApi.agents.createScoped, { orgId: t.orgId, name: 'inbox-early', origin: 'external' }), late = await t.human.action(anyApi.agents.createScoped, { orgId: t.orgId, name: 'inbox-late', origin: 'external' });
    await addNotes(998); await rest(early.key)('POST', 'inbox', { text: 'mine early' });
    await addNotes(2); await rest(late.key)('POST', 'inbox', { text: 'mine late' });
    const inbox = { earlyAfter998Hidden: JSON.parse((await rest(early.key)('GET', 'inbox')).text).length, lateAfter1001Hidden: JSON.parse((await rest(late.key)('GET', 'inbox')).text).length };
    const out = { suggestionsTiming: { low, high }, suggestionsCap: { at999, at1000 }, inbox };
    return out;
  });
  return { results, listed: listed.length };
}, { safetySim: true });
const pass = report.results.filter(r => r.status === 'PASS').length;
console.log(`R4 SUMMARY ${pass} PASS / ${report.results.length - pass} FAIL`);
writeFileSync(evidencePath('iv-r4.json'), JSON.stringify(report, null, 2) + '\n');
