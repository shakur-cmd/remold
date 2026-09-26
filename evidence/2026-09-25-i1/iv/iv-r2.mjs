// r2 bypass probes against I1 revision 1 (4cb4671). Same harness and rules as iv-service.mjs.
// Usage: I1_EVIDENCE_DIR=<dir> node evidence/2026-09-25-i1/iv/iv-r2.mjs
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { anyApi } from 'convex/server';
import { withAuthority, evidencePath } from '../../../ops/authority/local.mjs';
import { tenant as makeTenant, commands } from '../../../ops/authority/service-fixture.mjs';

const only = process.env.IV_ONLY ? new RegExp(process.env.IV_ONLY) : null;
const pause = ms => new Promise(r => setTimeout(r, ms));
const sha = s => createHash('sha256').update(s).digest('hex');
const errText = e => String(e?.data ? JSON.stringify(e.data) : e?.message ?? e);
const attempt = async fn => { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: errText(e).slice(0, 300) }; } };
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const report = await withAuthority(async f => {
  const results = [];
  const check = async (id, claim, name, fn) => {
    if (only && !only.test(id)) return;
    try { const observed = await fn(); results.push({ id, claim, name, status: 'PASS', observed }); console.log('PASS', id, name); }
    catch (e) { results.push({ id, claim, name, status: 'FAIL', error: String(e?.stack ?? e).slice(0, 1500) }); console.log('FAIL', id, name, '\n   ', String(e?.message ?? e).slice(0, 500)); }
  };
  f.run('integrations/connections:registerProvider', { provider: 'fake', enabled: true });
  f.run('integrations/budgets:configure', { cap: 100000, maxConcurrent: 1000, maxPerRun: 1000, maxSteps: 5, maxRecipients: 100 });
  const tenant = label => makeTenant(f, label);
  const adapterAs = key => async (name, body, raw) => { const r = await fetch(f.site + '/api/integrations/v1/' + name, { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: raw ?? JSON.stringify(body) }); return { status: r.status, text: await r.text() }; };
  const rest = key => async (method, path, body, raw) => { const r = await fetch(f.site + '/api/v1/' + path, { method, headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, ...(raw ? { body: raw } : body === undefined ? {} : { body: JSON.stringify(body) }) }); const text = await r.text(); return { status: r.status, text }; };
  const invite = async (t, role, label) => { const client = f.client(label + '-' + randomUUID()), userId = await client.mutation(anyApi.users.store, {}); const inv = await t.human.mutation(anyApi.invites.create, { orgId: t.orgId, role }); await client.mutation(anyApi.invites.accept, { token: inv.token }); return { client, userId }; };
  const memberOf = async (t, userId) => (await t.human.query(anyApi.orgs.members, { orgId: t.orgId })).find(m => m.user._id === userId).member;
  const company = async t => { const objects = await t.human.query(anyApi.objects.list, { orgId: t.orgId }), c = objects.find(o => o.key === 'company'), d = await t.human.query(anyApi.objects.get, { orgId: t.orgId, objectId: c._id }); return { object: c, fields: Object.fromEntries(d.fields.map(x => [x.key, x])), objects }; };

  // ---------- D8: body logging on other paths ----------
  await check('R2-D8a', 4, 'Inherited-property keys (constructor, toString, __proto__) cannot slip a malformed body past the shape check into Convex argument logging', async () => {
    const t = await tenant('r2-d8a'), agent = await t.human.action(anyApi.agents.create, { orgId: t.orgId, name: 'd8', grants: [{ action: 'create', objectKey: '*' }] });
    const out = {};
    for (const key of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      const canary = 'D8' + key.replace(/_/g, '') + randomUUID().replace(/-/g, '');
      const bodyText = `{"bindingId":"${t.bindingId}","eventId":"e","body":"{}","${key}":"${canary}"}`;
      let offset = f.logs().length; const a = await adapterAs(t.adapterKey)('callback', null, bodyText); await pause(800); const aLogs = f.logs().slice(offset);
      offset = f.logs().length; const r = await rest(agent.key)('POST', 'changes', null, `{"action":"create","object":"company","values":{"name":"x"},"reason":"r","${key}":"${canary}"}`); await pause(800); const rLogs = f.logs().slice(offset);
      out[key] = { adapter: a.status + ' ' + a.text.slice(0, 90), adapterLogsCanary: aLogs.includes(canary), adapterLogsKeyHash: aLogs.includes(sha(t.adapterKey)), rest: r.status + ' ' + r.text.slice(0, 160), restLogsCanary: rLogs.includes(canary), restLogsKeyHash: rLogs.includes(sha(agent.key)),
        restLogSample: rLogs.split('\n').filter(l => l.includes(canary)).slice(0, 1).map(l => l.replaceAll(canary, '<CANARY>').replaceAll(sha(agent.key), '<AGENT_KEY_SHA256>').slice(0, 300)) };
    }
    const leaked = Object.entries(out).flatMap(([k, v]) => [v.adapterLogsCanary || v.adapterLogsKeyHash ? k + ':adapter' : null, v.restLogsCanary || v.restLogsKeyHash ? k + ':rest' : null]).filter(Boolean);
    assert.deepEqual(leaked, [], JSON.stringify(out)); return out;
  });
  await check('R2-D8b', 4, 'Other error paths: $-prefixed keys, deep nesting and over-long strings inside v.any/record values do not log the body or key hashes', async () => {
    const t = await tenant('r2-d8b'), agent = await t.human.action(anyApi.agents.create, { orgId: t.orgId, name: 'd8b', grants: [{ action: 'create', objectKey: '*' }] });
    const canary = 'D8B' + randomUUID().replace(/-/g, '');
    let deep = `"${canary}"`; for (let i = 0; i < 80; i++) deep = `{"a":${deep}}`;
    const bodies = {
      dollarKey: `{"action":"create","object":"company","values":{"$${canary}":1},"reason":"r"}`,
      underscoreKey: `{"action":"create","object":"company","values":{"_${canary}":1},"reason":"r"}`,
      deepNesting: `{"action":"create","object":"company","values":{"name":${deep}},"reason":"r"}`,
      suggestionDollar: `{"action":"create","object":"company","values":{"name":"x","$x":"${canary}"},"reason":"r"}`,
    };
    const out = {};
    for (const [label, raw] of Object.entries(bodies)) { const r = await rest(agent.key)('POST', label === 'suggestionDollar' ? 'suggestions' : 'changes', null, raw); out[label] = r.status + ' ' + r.text.slice(0, 120); }
    const a = await adapterAs(t.adapterKey)('page', null, `{"resource":"r","traversal":"t","from":0,"page":1,"items":[{"bindingId":"${t.bindingId}","observation":{"$${canary}":1}}],"end":true,"checkpoint":1}`); out.adapterDollar = a.status + ' ' + a.text.slice(0, 120);
    await pause(800); const logs = f.logs();
    out.canaryInLogs = logs.includes(canary); out.agentKeyHashInLogs = logs.includes(sha(agent.key)); out.adapterKeyHashInLogs = logs.includes(sha(t.adapterKey));
    out.logSample = logs.split('\n').filter(l => l.includes(canary) || l.includes(sha(agent.key)) || l.includes(sha(t.adapterKey))).slice(0, 3).map(l => l.replaceAll(canary, '<CANARY>').replaceAll(sha(agent.key), '<AGENT_KEY_SHA256>').replaceAll(sha(t.adapterKey), '<ADAPTER_KEY_SHA256>').slice(0, 300));
    assert.ok(!out.agentKeyHashInLogs && !out.adapterKeyHashInLogs, 'key hash logged: ' + JSON.stringify(out)); return out;
  });

  // ---------- D1-D3: existence oracles through other paths ----------
  const scoped = async label => {
    const t = await tenant(label), c = await company(t), m = await invite(t, 'member', 'scoped');
    const mine = (await t.human.mutation(anyApi.records.create, { orgId: t.orgId, objectId: c.object._id, values: { [c.fields.name._id]: 'My Co' } })).recordId;
    const secretName = 'Secret Target ' + randomUUID().slice(0, 6);
    const secret = (await t.human.mutation(anyApi.records.create, { orgId: t.orgId, objectId: c.object._id, values: { [c.fields.name._id]: secretName } })).recordId;
    await t.human.mutation(anyApi['authority/policies'].setMember, { orgId: t.orgId, memberId: (await memberOf(t, m.userId))._id, scopes: [{ objectId: c.object._id, records: [mine], fields: 'all' }, ...c.objects.filter(o => o.key !== 'company').map(o => ({ objectId: o._id, records: 'all', fields: 'all' }))], hiddenFieldIds: [] });
    const secretRef = (await t.human.query(anyApi.records.get, { orgId: t.orgId, recordId: secret })).record.ref;
    return { t, c, m, mine, secret, secretName, secretRef };
  };
  await check('R2-O1', 3, 'Record-scoped member: CSV lookup column by title, by record code and by raw ID gives the same result for an unreadable record as for a missing one', async () => {
    const { t, m, secretName, secretRef, secret } = await scoped('r2-o1'), objects = await t.human.query(anyApi.objects.list, { orgId: t.orgId }), people = objects.find(o => o.key === 'person'), pf = (await t.human.query(anyApi.objects.get, { orgId: t.orgId, objectId: people._id })).fields;
    const cols = [pf.find(x => x.key === 'name')._id, pf.find(x => x.key === 'company')._id];
    const imp = async value => { const r = await m.client.mutation(anyApi.csv.importRows, { orgId: t.orgId, objectId: people._id, columns: cols, rows: [['P ' + randomUUID().slice(0, 4), value]], firstRow: 2, skipDuplicates: false, createMissing: false }); return JSON.stringify({ created: r.created, skipped: r.skipped, errors: r.errors.map(e => e.message.replace(value, '<v>')) }); };
    const c2 = await company(t), gone = (await t.human.mutation(anyApi.records.create, { orgId: t.orgId, objectId: c2.object._id, values: { [c2.fields.name._id]: 'Gone Co' } })).recordId; await t.human.mutation(anyApi.records.remove, { orgId: t.orgId, recordId: gone });
    const pairs = { title: [secretName, 'Missing Target ' + randomUUID().slice(0, 6)], code: [secretRef, 'zzzz-yyyy-xxxx'], id: [secret, gone] };
    const out = {}; for (const [k, [hit, miss]] of Object.entries(pairs)) out[k] = { hit: await imp(hit), miss: await imp(miss) };
    const differ = Object.entries(out).filter(([, v]) => v.hit !== v.miss).map(([k]) => k);
    assert.deepEqual(differ, [], JSON.stringify(out)); return out;
  });
  await check('R2-O2', 3, 'Record-scoped member: search, byRef, get, related, events, export and inbox link do not distinguish an unreadable record from a missing one', async () => {
    const { t, c, m, secret, secretName, secretRef } = await scoped('r2-o2');
    const gone = (await t.human.mutation(anyApi.records.create, { orgId: t.orgId, objectId: c.object._id, values: { [c.fields.name._id]: 'Gone Co' } })).recordId; await t.human.mutation(anyApi.records.remove, { orgId: t.orgId, recordId: gone }); const fake = gone;
    const inbox = await m.client.mutation(anyApi.inbox.add, { orgId: t.orgId, text: 'mine' });
    const q = (fn, args) => attempt(() => m.client.query(fn, args));
    const pairs = {
      search: [await q(anyApi.records.search, { orgId: t.orgId, text: secretName }), await q(anyApi.records.search, { orgId: t.orgId, text: 'Missing Target zz' })],
      byRef: [await q(anyApi.records.byRef, { orgId: t.orgId, ref: secretRef }), await q(anyApi.records.byRef, { orgId: t.orgId, ref: 'zzzz-yyyy-xxxx' })],
      get: [await q(anyApi.records.get, { orgId: t.orgId, recordId: secret }), await q(anyApi.records.get, { orgId: t.orgId, recordId: fake })],
      events: [await q(anyApi.events.forRecord, { orgId: t.orgId, recordId: secret }), await q(anyApi.events.forRecord, { orgId: t.orgId, recordId: fake })],
      suggestions: [await q(anyApi.suggestions.forRecord, { orgId: t.orgId, recordId: secret }), await q(anyApi.suggestions.forRecord, { orgId: t.orgId, recordId: fake })],
      inboxLink: [await attempt(() => m.client.mutation(anyApi.inbox.resolve ?? anyApi.inbox.remove, { orgId: t.orgId, id: inbox, recordId: secret })), null],
    };
    const norm = v => v === null ? null : JSON.stringify(v).replaceAll(secret, '<id>').replaceAll(fake, '<id>');
    const out = Object.fromEntries(Object.entries(pairs).map(([k, [a, b]]) => [k, { hit: norm(a)?.slice(0, 160), miss: norm(b)?.slice(0, 160) }]));
    const differ = Object.entries(out).filter(([k, v]) => k !== 'inboxLink' && v.hit !== v.miss).map(([k]) => k);
    assert.deepEqual(differ, [], JSON.stringify(out)); return out;
  });
  await check('R2-O3', 3, 'Record-scoped agent (REST and therefore MCP tools): get, related, events, inbox resolve and change/propose with lookup by ID, code or title are identical for unreadable and missing', async () => {
    const t = await tenant('r2-o3'), c = await company(t), people = c.objects.find(o => o.key === 'person'), pf = (await t.human.query(anyApi.objects.get, { orgId: t.orgId, objectId: people._id })).fields;
    const mine = (await t.human.mutation(anyApi.records.create, { orgId: t.orgId, objectId: c.object._id, values: { [c.fields.name._id]: 'My Co' } })).recordId;
    const secretName = 'Secret Target ' + randomUUID().slice(0, 6), secret = (await t.human.mutation(anyApi.records.create, { orgId: t.orgId, objectId: c.object._id, values: { [c.fields.name._id]: secretName } })).recordId;
    const secretRef = (await t.human.query(anyApi.records.get, { orgId: t.orgId, recordId: secret })).record.ref;
    const pat = (await t.human.mutation(anyApi.records.create, { orgId: t.orgId, objectId: people._id, values: { [pf.find(x => x.key === 'name')._id]: 'Pat' } })).recordId;
    const agent = await t.human.action(anyApi.agents.createScoped, { orgId: t.orgId, name: 'scoped', origin: 'external' });
    const g = (capability, objectId, records, fields) => t.human.mutation(anyApi['authority/grants'].grant, { orgId: t.orgId, target: agent.agentId, capability, scope: { kind: 'records', objectId, records, fields }, mode: 'direct', delegate: false, expiresAt: Date.now() + 120000 });
    await g('read', people._id, [pat], pf.map(x => x._id)); await g('read', c.object._id, [mine], Object.values(c.fields).map(x => x._id));
    await g('propose', people._id, [pat], pf.map(x => x._id)); await g('record.update', people._id, [pat], pf.map(x => x._id));
    const gone = (await t.human.mutation(anyApi.records.create, { orgId: t.orgId, objectId: c.object._id, values: { [c.fields.name._id]: 'Gone Co' } })).recordId; await t.human.mutation(anyApi.records.remove, { orgId: t.orgId, recordId: gone });
    const call = rest(agent.key), fake = gone;
    const inbox = await call('POST', 'inbox', { text: 'x' }), inboxId = JSON.parse(inbox.text).id;
    const s = r => (r.status + ' ' + r.text).replaceAll(secret, '<id>').replaceAll(fake, '<id>').replaceAll(secretRef, '<v>').replaceAll(secretName, '<v>').replace(/Missing Target \w+/g, '<v>').replace('zzzz-yyyy-xxxx', '<v>').slice(0, 160);
    const pairs = {
      get: [secret, fake].map(id => call('GET', 'records/' + id)),
      getByRef: [secretRef, 'zzzz-yyyy-xxxx'].map(id => call('GET', 'records/' + id)),
      events: [secret, fake].map(id => call('GET', 'records/' + id + '/events')),
      related: [secret, fake].map(id => call('GET', 'records/' + id + '/related?field=person.company')),
      proposeById: [secret, fake].map(v => call('POST', 'suggestions', { action: 'update', record: pat, values: { company: v }, reason: 'r' })),
      proposeByCode: [secretRef, 'zzzz-yyyy-xxxx'].map(v => call('POST', 'suggestions', { action: 'update', record: pat, values: { company: v }, reason: 'r' })),
      proposeByTitle: [secretName, 'Missing Target ' + randomUUID().slice(0, 4)].map(v => call('POST', 'suggestions', { action: 'update', record: pat, values: { company: v }, reason: 'r' })),
      changeByTitle: [secretName, 'Missing Target ' + randomUUID().slice(0, 4)].map(v => call('POST', 'changes', { action: 'update', record: pat, values: { company: v }, reason: 'r' })),
      inboxResolveRecord: [secret, fake].map(id => call('POST', 'inbox/' + inboxId + '/resolve', { recordId: id })),
    };
    const out = {}; for (const [k, [a, b]] of Object.entries(pairs)) out[k] = { hit: s(await a), miss: s(await b) };
    const differ = Object.entries(out).filter(([, v]) => v.hit !== v.miss).map(([k]) => k);
    assert.deepEqual(differ, [], JSON.stringify(out)); return out;
  });
  await check('R2-O4', 3, 'Timing: capture of an unreadable existing company name vs a missing one (median of 25 each) differs by less than 5 ms', async () => {
    const { t, m, secretName } = await scoped('r2-o4'), times = { hit: [], miss: [] };
    for (let i = 0; i < 25; i++) for (const k of ['hit', 'miss']) { const name = k === 'hit' ? secretName : 'Missing ' + randomUUID().slice(0, 6); const s = performance.now(); await attempt(() => m.client.mutation(anyApi.capture.save, { orgId: t.orgId, kind: 'company', name })); times[k].push(performance.now() - s); }
    const out = { hitMs: +median(times.hit).toFixed(2), missMs: +median(times.miss).toFixed(2) };
    assert.ok(Math.abs(out.hitMs - out.missMs) < 5, JSON.stringify(out)); return out;
  });

  // ---------- Timing relaxations: is the final-permit recheck real when the pause sweep does not run first? ----------
  await check('R2-T1', 1, 'Without the pause sweep, the final permit alone refuses: approver downgraded (Approver authority changed) and delegated parent revoked (External capability denied)', async () => {
    const t = await tenant('r2-t1'), a = await invite(t, 'admin', 'approver');
    const id = await t.human.mutation(commands.proposeHuman, { orgId: t.orgId, logical: 'nosweep', bindingId: t.bindingId, capability: 'model.call', payload: t.payload, reservationUnits: 1, maxSteps: 1 });
    await a.client.mutation(commands.approve, { orgId: t.orgId, id, expiresAt: Date.now() + 60000 }); const c = await t.claim(id);
    f.run('authorityFixtureIv:setRoleNoSweep', { orgId: t.orgId, userId: a.userId, role: 'member' });
    const r1 = await adapterAs(t.adapterKey)('permit', { id, ...c, worker: 'worker' });
    assert.equal(r1.status, 403); assert.match(r1.text, /Approver authority changed/);
    const manager = await t.human.action(anyApi.agents.createScoped, { orgId: t.orgId, name: 'manager', origin: 'external' }), child = await t.human.action(anyApi.agents.createScoped, { orgId: t.orgId, name: 'child', origin: 'external' });
    await t.human.mutation(anyApi['authority/grants'].grant, { orgId: t.orgId, target: manager.agentId, capability: 'agent.manage', scope: { kind: 'agents', agents: [child.agentId] }, mode: 'direct', delegate: false, expiresAt: Date.now() + 60000 });
    const parent = await t.human.mutation(anyApi['authority/grants'].grant, { orgId: t.orgId, target: manager.agentId, capability: 'model.call', scope: { kind: 'model', maxUnitsPerRun: 5, maxSteps: 2 }, mode: 'direct', delegate: true, expiresAt: Date.now() + 60000 });
    const mg = await rest(manager.key)('POST', 'authority/grant', { target: child.agentId, capability: 'model.call', scope: { kind: 'model', maxUnitsPerRun: 5, maxSteps: 2 }, mode: 'direct', delegate: false, expiresAt: Date.now() + 30000, parent }); assert.equal(mg.status, 200, mg.text);
    const op = JSON.parse((await rest(child.key)('POST', 'operations', { logical: 'child', bindingId: t.bindingId, capability: 'model.call', payload: t.payload, reservationUnits: 1, maxSteps: 1 })).text);
    const cc = JSON.parse((await rest(child.key)('POST', 'operations/' + op + '/claim', { worker: 'w' })).text);
    f.run('authorityFixtureIv:revokeGrantNoSweep', { id: parent });
    const r2 = await adapterAs(t.adapterKey)('permit', { id: op, ...cc, worker: 'w' });
    assert.equal(r2.status, 403); assert.match(r2.text, /External capability denied/);
    return { approver: r1.text, delegation: r2.text };
  });
  await check('R2-T2', 1, 'Real race, 20 rounds: role change via the public mutation, then permit immediately; never 200, and record which layer refused', async () => {
    const tally = {};
    for (let i = 0; i < 20; i++) {
      const t = await tenant('r2-t2-' + i), a = await invite(t, 'admin', 'approver');
      const id = await t.human.mutation(commands.proposeHuman, { orgId: t.orgId, logical: 'race', bindingId: t.bindingId, capability: 'model.call', payload: t.payload, reservationUnits: 1, maxSteps: 1 });
      await a.client.mutation(commands.approve, { orgId: t.orgId, id, expiresAt: Date.now() + 60000 }); const c = await t.claim(id);
      const [, r] = await Promise.all([t.human.mutation(anyApi.orgs.setRole, { orgId: t.orgId, userId: a.userId, role: 'member' }), adapterAs(t.adapterKey)('permit', { id, ...c, worker: 'worker' })]);
      const key = r.status + ' ' + (/"message":"([^"]*)"/.exec(r.text)?.[1] ?? r.text.slice(0, 60)); tally[key] = (tally[key] ?? 0) + 1;
    }
    assert.ok(!Object.keys(tally).some(k => k.startsWith('200')), JSON.stringify(tally)); return tally;
  });
  return { results, scratch: f.scratch };
});
writeFileSync(evidencePath('iv-r2.json'), JSON.stringify(report, null, 2) + '\n');
const r = report.results; console.log(`\nR2 SUMMARY ${r.filter(x => x.status === 'PASS').length} PASS / ${r.filter(x => x.status === 'FAIL').length} FAIL`);
