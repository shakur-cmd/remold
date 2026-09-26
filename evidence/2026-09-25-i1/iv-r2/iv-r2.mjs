// IV round 2: bypass probes against I1 revision 1 (4cb4671). Same harness and rules as
// ../iv/iv-service.mjs: isolated local Convex on 3490/3491, synthetic JWTs and data.
// Needs ops/authority/fixture-iv.ts from this folder. Every check records what it saw.
// Usage: I1_EVIDENCE_DIR=<dir> node evidence/2026-09-25-i1/iv-r2/iv-r2.mjs
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { anyApi } from 'convex/server';
import { withAuthority, evidencePath } from '../../../ops/authority/local.mjs';
import { tenant as makeTenant, commands } from '../../../ops/authority/service-fixture.mjs';
import inventory from '../../../ops/authority/inventory.json' with { type: 'json' };

const only = process.env.IV_ONLY ? new RegExp(process.env.IV_ONLY) : null;
const pause = ms => new Promise(r => setTimeout(r, ms));
const sha = s => createHash('sha256').update(s).digest('hex');
const errText = e => String(e?.data ? JSON.stringify(e.data) : e?.stderr ? String(e.stderr) : e?.message ?? e);
const attempt = async fn => { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: errText(e).slice(0, 300) }; } };
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const label = id => inventory.find(r => r.id === id)?.readonly;

const report = await withAuthority(async f => {
  const results = [], secrets = { agentKeys: [], adapterKeys: [] };
  const check = async (id, claim, name, fn) => {
    if (only && !only.test(id)) return;
    try { const observed = await fn(); results.push({ id, claim, name, status: 'PASS', observed }); console.log('PASS', id, name); }
    catch (e) { results.push({ id, claim, name, status: 'FAIL', error: String(e?.stack ?? e).slice(0, 30000) }); console.log('FAIL', id, name, '\n   ', String(e?.message ?? e).slice(0, 700)); }
  };
  const runTry = (fn, args) => { try { return { ok: true, value: f.run(fn, args) }; } catch (e) { return { ok: false, error: String(e?.stderr ?? e?.message ?? e).split('\n').filter(l => /Error|error|refus|readonly|Read-only|READONLY|FORBIDDEN|code/.test(l)).slice(0, 2).join(' | ').slice(0, 240) }; } };
  f.run('integrations/connections:registerProvider', { provider: 'fake', enabled: true });
  f.run('integrations/budgets:configure', { cap: 100000, maxConcurrent: 1000, maxPerRun: 1000, maxSteps: 5, maxRecipients: 100 });
  const tenant = async label => { const t = await makeTenant(f, label); secrets.adapterKeys.push(t.adapterKey); return t; };
  const newAgent = async (t, args, scoped = false) => { const a = await t.human.action(scoped ? anyApi.agents.createScoped : anyApi.agents.create, { orgId: t.orgId, ...args }); secrets.agentKeys.push(a.key); return a; };
  const adapterAs = key => async (name, body, raw) => { const r = await fetch(f.site + '/api/integrations/v1/' + name, { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: raw ?? JSON.stringify(body) }); return { status: r.status, text: await r.text() }; };
  const rest = key => async (method, path, body, raw) => { const r = await fetch(f.site + '/api/v1/' + path, { method, headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, ...(raw ? { body: raw } : body === undefined ? {} : { body: JSON.stringify(body) }) }); const text = await r.text(); return { status: r.status, text }; };
  const invite = async (t, role, label) => { const client = f.client(label + '-' + randomUUID()), userId = await client.mutation(anyApi.users.store, {}); const inv = await t.human.mutation(anyApi.invites.create, { orgId: t.orgId, role }); await client.mutation(anyApi.invites.accept, { token: inv.token }); return { client, userId }; };
  const memberOf = async (t, userId) => (await t.human.query(anyApi.orgs.members, { orgId: t.orgId })).find(m => m.user._id === userId).member;
  const objectOf = async (t, key) => { const objects = await t.human.query(anyApi.objects.list, { orgId: t.orgId }), o = objects.find(x => x.key === key), d = await t.human.query(anyApi.objects.get, { orgId: t.orgId, objectId: o._id }); return { object: o, fields: Object.fromEntries(d.fields.map(x => [x.key, x])), objects }; };
  const company = t => objectOf(t, 'company');
  const makeRecord = async (t, key, title) => { const o = await objectOf(t, key), titleKey = o.fields.name ? 'name' : 'title'; return (await t.human.mutation(anyApi.records.create, { orgId: t.orgId, objectId: o.object._id, values: { [o.fields[titleKey]._id]: title } })).recordId; };
  const deleted = async (t, key) => { const id = await makeRecord(t, key, 'Gone ' + randomUUID().slice(0, 4)); await t.human.mutation(anyApi.records.remove, { orgId: t.orgId, recordId: id }); return id; };
  const logScan = (text, extra = []) => ({ agentKeyHash: secrets.agentKeys.some(k => text.includes(sha(k))), adapterKeyHash: secrets.adapterKeys.some(k => text.includes(sha(k))), extra: extra.filter(x => text.includes(x)).length });
  const redact = (line, canary) => { let s = line.replaceAll(canary, '<CANARY>'); for (const k of [...secrets.agentKeys, ...secrets.adapterKeys]) s = s.replaceAll(sha(k), '<KEY_SHA256>'); return s.slice(0, 300); };

  // ================= Claim 4: request bodies never reach Convex argument logging =================
  await check('R2-D8a', 4, 'Inherited-property keys (constructor, toString, hasOwnProperty, __proto__) cannot slip an extra field past the shape check into Convex argument logging', async () => {
    const t = await tenant('r2-d8a'), agent = await newAgent(t, { name: 'd8', grants: [{ action: 'create', objectKey: '*' }] });
    const inbox = JSON.parse((await rest(agent.key)('POST', 'inbox', { text: 'x' })).text).id;
    const out = {};
    for (const key of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__']) {
      const canary = 'D8' + key.replace(/_/g, '') + randomUUID().replace(/-/g, '');
      const probes = {
        'adapter callback': () => adapterAs(t.adapterKey)('callback', null, `{"bindingId":"${t.bindingId}","eventId":"e-${canary}","body":"{}","${key}":"${canary}"}`),
        'rest changes': () => rest(agent.key)('POST', 'changes', null, `{"action":"create","object":"company","values":{"name":"x"},"reason":"r","${key}":"${canary}"}`),
        'rest suggestions': () => rest(agent.key)('POST', 'suggestions', null, `{"action":"create","object":"company","values":{"name":"x"},"reason":"r","${key}":"${canary}"}`),
        'rest inbox': () => rest(agent.key)('POST', 'inbox', null, `{"text":"x","${key}":"${canary}"}`),
        'rest inbox resolve': () => rest(agent.key)('POST', 'inbox/' + inbox + '/resolve', null, `{"note":"n","${key}":"${canary}"}`),
      };
      for (const [route, go] of Object.entries(probes)) {
        const offset = f.logs().length, r = await go(); await pause(600); const logs = f.logs().slice(offset), scan = logScan(logs, [canary]);
        out[key + ' | ' + route] = { response: r.status + ' ' + redact(r.text, canary).slice(0, 110), logsCanary: scan.extra > 0, logsKeyHash: scan.agentKeyHash || scan.adapterKeyHash, responseKeyHash: logScan(r.text).agentKeyHash || logScan(r.text).adapterKeyHash,
          logSample: logs.split('\n').filter(l => l.includes(canary)).slice(0, 1).map(l => redact(l, canary)) };
      }
    }
    const leaked = Object.entries(out).filter(([, v]) => v.logsCanary || v.logsKeyHash || v.responseKeyHash).map(([k]) => k);
    assert.deepEqual(leaked, [], JSON.stringify(Object.fromEntries(leaked.map(k => [k, out[k]])))); return out;
  });
  await check('R2-D8b', 4, 'Field names Convex refuses ($-prefixed, _-prefixed, empty) and over-deep nesting inside record/any values do not log the body or key hashes', async () => {
    const t = await tenant('r2-d8b'), agent = await newAgent(t, { name: 'd8b', grants: [{ action: 'create', objectKey: '*' }] });
    const canary = 'D8B' + randomUUID().replace(/-/g, '');
    let deep = `"${canary}"`; for (let i = 0; i < 80; i++) deep = `{"a":${deep}}`;
    const bodies = {
      dollarKey: ['changes', `{"action":"create","object":"company","values":{"$${canary}":1},"reason":"r"}`],
      underscoreKey: ['changes', `{"action":"create","object":"company","values":{"_${canary}":1},"reason":"r"}`],
      emptyKey: ['changes', `{"action":"create","object":"company","values":{"":"${canary}"},"reason":"r"}`],
      nestedDollar: ['changes', `{"action":"create","object":"company","values":{"name":{"$x":"${canary}"}},"reason":"r"}`],
      deepNesting: ['changes', `{"action":"create","object":"company","values":{"name":${deep}},"reason":"r"}`],
      suggestionDollar: ['suggestions', `{"action":"create","object":"company","values":{"name":"x","$x":"${canary}"},"reason":"r"}`],
    };
    const out = {}, offset = f.logs().length;
    for (const [k, [path, raw]] of Object.entries(bodies)) { const r = await rest(agent.key)('POST', path, null, raw); out[k] = r.status + ' ' + redact(r.text, canary).slice(0, 140); }
    const a = await adapterAs(t.adapterKey)('page', null, `{"resource":"r","traversal":"t","from":0,"page":1,"items":[{"bindingId":"${t.bindingId}","observation":{"$${canary}":1}}],"end":true,"checkpoint":1}`); out.adapterDollar = a.status + ' ' + redact(a.text, canary).slice(0, 140);
    await pause(800); const logs = f.logs().slice(offset), scan = logScan(logs, [canary]);
    Object.assign(out, { canaryInLogs: scan.extra > 0, keyHashInLogs: scan.agentKeyHash || scan.adapterKeyHash, logSample: logs.split('\n').filter(l => l.includes(canary) || logScan(l).agentKeyHash || logScan(l).adapterKeyHash).slice(0, 3).map(l => redact(l, canary)) });
    // Strict on key hashes and whole bodies; a caller-chosen field name echoed in a domain error is recorded, not failed.
    out.bodyLogged = logs.split('\n').some(l => l.includes(canary) && /Object: \{/.test(l));
    assert.ok(!out.keyHashInLogs && !out.bodyLogged, 'logged: ' + JSON.stringify(out)); return out;
  });
  await check('R2-D8c', 4, 'Regression of the D8 fix: extra fields, wrong types and wrong-table IDs on all 15 adapter routes and all 11 agent POST routes get 400 and log nothing', async () => {
    const t = await tenant('r2-d8c'), agent = await newAgent(t, { name: 'd8c', grants: [{ action: 'create', objectKey: '*' }] });
    const canary = 'D8C' + randomUUID().replace(/-/g, ''), wrong = t.orgId; // an ID from the orgs table
    const adapterRoutes = ['permit', 'consume', 'unknown', 'reconcile', 'fail', 'safety-begin', 'safety-complete', 'safety-receipt', 'resolve-unknown', 'bind', 'page', 'callback', 'status', 'lookup', 'safety-resolve-unknown'];
    const restRoutes = ['operations', 'operations/' + wrong + '/edit', 'operations/' + wrong + '/claim', 'operations/' + wrong + '/cancel', 'authority/grant', 'authority/revoke', 'authority/fire', 'suggestions', 'changes', 'inbox', 'inbox/' + wrong + '/resolve'];
    const bodies = [{ extra: canary }, { id: wrong, bindingId: wrong, intentId: wrong, targetId: wrong, lookupId: wrong, target: wrong, note: canary }, { bindingId: wrong, eventId: canary, body: canary }, { id: canary, fence: canary, worker: canary }];
    const out = {}, offset = f.logs().length;
    for (const name of adapterRoutes) out['adapter ' + name] = [...new Set(await Promise.all(bodies.map(async b => (await adapterAs(t.adapterKey)(name, b)).status)))].join(',');
    for (const path of restRoutes) out['rest ' + path.replace(wrong, ':id')] = [...new Set(await Promise.all(bodies.map(async b => (await rest(agent.key)('POST', path, b)).status)))].join(',');
    await pause(1000); const logs = f.logs().slice(offset), scan = logScan(logs, [canary, wrong]);
    out.logs = { canaryOrWrongId: scan.extra, keyHash: scan.agentKeyHash || scan.adapterKeyHash, sample: logs.split('\n').filter(l => l.includes(canary) || logScan(l).agentKeyHash || logScan(l).adapterKeyHash).slice(0, 3).map(l => redact(l, canary)) };
    const not400 = Object.entries(out).filter(([k, v]) => k !== 'logs' && !/^(400|404|401)(,(400|404|401))*$/.test(v)).map(([k, v]) => k + '=' + v);
    assert.deepEqual(not400, [], JSON.stringify(out)); assert.ok(!out.logs.keyHash && out.logs.canaryOrWrongId === 0, JSON.stringify(out.logs)); return out;
  });

  // ================= Claim 3: existence oracles through other paths =================
  const scoped = async label => {
    const t = await tenant(label), c = await company(t), m = await invite(t, 'member', 'scoped');
    const mine = await makeRecord(t, 'company', 'Alpha Mine ' + randomUUID().slice(0, 4));
    const secretName = 'Secret Target ' + randomUUID().slice(0, 6), secret = await makeRecord(t, 'company', secretName);
    await t.human.mutation(anyApi['authority/policies'].setMember, { orgId: t.orgId, memberId: (await memberOf(t, m.userId))._id, scopes: [{ objectId: c.object._id, records: [mine], fields: 'all' }, ...c.objects.filter(o => o.key !== 'company').map(o => ({ objectId: o._id, records: 'all', fields: 'all' }))], hiddenFieldIds: [] });
    const secretRef = (await t.human.query(anyApi.records.get, { orgId: t.orgId, recordId: secret })).record.ref, gone = await deleted(t, 'company');
    return { t, c, m, mine, secret, secretName, secretRef, gone };
  };
  const missRef = 'zzzz-yyyy-xxxx';
  await check('R2-O1', 3, 'Record-scoped member, CSV lookup column: title, record code and raw ID give the same outcome for an unreadable record as for a missing one (with and without skipDuplicates)', async () => {
    const { t, m, secretName, secretRef, secret, gone } = await scoped('r2-o1'), people = await objectOf(t, 'person');
    const cols = [people.fields.name._id, people.fields.company._id];
    const imp = async (value, skipDuplicates) => { const r = await attempt(() => m.client.mutation(anyApi.csv.importRows, { orgId: t.orgId, objectId: people.object._id, columns: cols, rows: [['P ' + randomUUID().slice(0, 4), value]], firstRow: 2, skipDuplicates, createMissing: false })); return JSON.stringify(r.ok ? { created: r.value.created, skipped: r.value.skipped, errors: r.value.errors.map(e => e.message.replaceAll(value, '<v>')) } : r.error.replaceAll(value, '<v>')); };
    const pairs = { title: [secretName, 'Missing Target ' + randomUUID().slice(0, 6)], code: [secretRef, missRef], id: [secret, gone] };
    const out = {}; for (const skip of [false, true]) for (const [k, [hit, miss]] of Object.entries(pairs)) out[k + (skip ? '+skip' : '')] = { hit: await imp(hit, skip), miss: await imp(miss, skip) };
    const differ = Object.entries(out).filter(([, v]) => v.hit !== v.miss).map(([k]) => k);
    assert.deepEqual(differ, [], JSON.stringify(out)); return out;
  });
  await check('R2-O2', 3, 'Record-scoped member: search, byRef, get, events, suggestions and related-list queries do not distinguish an unreadable record from a missing or deleted one', async () => {
    const { t, m, secret, secretName, secretRef, gone } = await scoped('r2-o2'), people = await objectOf(t, 'person');
    const q = (fn, args) => attempt(() => m.client.query(fn, args));
    const pairs = {
      search: [q(anyApi.records.search, { orgId: t.orgId, text: secretName }), q(anyApi.records.search, { orgId: t.orgId, text: 'Missing Target zz' })],
      byRef: [q(anyApi.records.byRef, { orgId: t.orgId, ref: secretRef }), q(anyApi.records.byRef, { orgId: t.orgId, ref: missRef })],
      get: [q(anyApi.records.get, { orgId: t.orgId, recordId: secret }), q(anyApi.records.get, { orgId: t.orgId, recordId: gone })],
      eventsById: [q(anyApi.events.forRecord, { orgId: t.orgId, recordId: secret }), q(anyApi.events.forRecord, { orgId: t.orgId, recordId: gone })],
      suggestionsById: [q(anyApi.suggestions.forRecord, { orgId: t.orgId, recordId: secret }), q(anyApi.suggestions.forRecord, { orgId: t.orgId, recordId: gone })],
      relatedById: [q(anyApi.records.related, { orgId: t.orgId, recordId: secret, fieldId: people.fields.company._id, paginationOpts: { numItems: 5, cursor: null } }), q(anyApi.records.related, { orgId: t.orgId, recordId: gone, fieldId: people.fields.company._id, paginationOpts: { numItems: 5, cursor: null } })],
    };
    // Can a member learn an unreadable record's ID at all? Link a readable person to the secret company and look.
    const pat = await makeRecord(t, 'person', 'Pat'); await t.human.mutation(anyApi.records.update, { orgId: t.orgId, recordId: pat, values: { [people.fields.company._id]: secret } });
    const patSeen = JSON.stringify(await m.client.query(anyApi.records.get, { orgId: t.orgId, recordId: pat })) + JSON.stringify(await m.client.query(anyApi.events.forRecord, { orgId: t.orgId, recordId: pat }));
    const idExposure = { secretIdVisibleViaReadablePerson: patSeen.includes(secret) };
    const norm = v => JSON.stringify(v).replaceAll(secret, '<id>').replaceAll(gone, '<id>').replace(/"continueCursor":"[^"]*"/, '"continueCursor":"<c>"');
    const out = {}; for (const [k, [a, b]] of Object.entries(pairs)) out[k] = { hit: norm(await a).slice(0, 200), miss: norm(await b).slice(0, 200) };
    const differ = Object.entries(out).filter(([, v]) => v.hit !== v.miss).map(([k]) => k);
    out.idExposure = idExposure;
    assert.deepEqual(differ, [], JSON.stringify(out)); return out;
  });
  await check('R2-O3', 3, 'Record-scoped agent over REST (and so MCP): get, byRef, events, related, inbox resolve, propose/change with lookup by ID, code or title, and a links field, are identical for unreadable and missing', async () => {
    const t = await tenant('r2-o3'), c = await company(t), people = await objectOf(t, 'person'), camp = await objectOf(t, 'campaign');
    const mine = await makeRecord(t, 'company', 'My Co'), secretName = 'Secret Target ' + randomUUID().slice(0, 6), secret = await makeRecord(t, 'company', secretName);
    const secretRef = (await t.human.query(anyApi.records.get, { orgId: t.orgId, recordId: secret })).record.ref;
    const pat = await makeRecord(t, 'person', 'Pat'), gone = await deleted(t, 'company');
    const agent = await newAgent(t, { name: 'scoped', origin: 'external' }, true);
    const g = (capability, o, records) => t.human.mutation(anyApi['authority/grants'].grant, { orgId: t.orgId, target: agent.agentId, capability, scope: { kind: 'records', objectId: o.object._id, records, fields: Object.values(o.fields).map(x => x._id) }, mode: 'direct', delegate: false, expiresAt: Date.now() + 300000 });
    await g('read', people, [pat]); await g('read', c, [mine]); await g('propose', people, [pat]); await g('record.update', people, [pat]);
    await g('read', camp, 'all'); await g('propose', camp, 'all'); await g('record.create', camp, 'all');
    const call = rest(agent.key), inboxId = JSON.parse((await call('POST', 'inbox', { text: 'x' })).text).id;
    const s = r => (r.status + ' ' + r.text).replaceAll(secret, '<id>').replaceAll(gone, '<id>').replaceAll(secretRef, '<v>').replaceAll(missRef, '<v>').replaceAll(secretName, '<v>').replace(/Missing Target \w+/g, '<v>').replace(/"id":"[^"]*"/g, '"id":"<x>"').replace(/"ref":"[^"]*"/g, '"ref":"<x>"').replace(/"(_creationTime|createdAt|updatedAt|_id)":[^,}]*/g, '"$1":<x>').slice(0, 220);
    const miss = () => 'Missing Target ' + randomUUID().slice(0, 4);
    const pairs = {
      get: [secret, gone].map(id => () => call('GET', 'records/' + id)),
      getByRef: [secretRef, missRef].map(id => () => call('GET', 'records/' + id)),
      events: [secret, gone].map(id => () => call('GET', 'records/' + id + '/events')),
      related: [secret, gone].map(id => () => call('GET', 'records/' + id + '/related?field=person.company')),
      proposeById: [secret, gone].map(v => () => call('POST', 'suggestions', { action: 'update', record: pat, values: { company: v }, reason: 'r' })),
      proposeByCode: [secretRef, missRef].map(v => () => call('POST', 'suggestions', { action: 'update', record: pat, values: { company: v }, reason: 'r' })),
      proposeByTitle: [secretName, miss()].map(v => () => call('POST', 'suggestions', { action: 'update', record: pat, values: { company: v }, reason: 'r' })),
      changeById: [secret, gone].map(v => () => call('POST', 'changes', { action: 'update', record: pat, values: { company: v }, reason: 'r' })),
      changeByTitle: [secretName, miss()].map(v => () => call('POST', 'changes', { action: 'update', record: pat, values: { company: v }, reason: 'r' })),
      linksProposeByTitle: [secretName, miss()].map(v => () => call('POST', 'suggestions', { action: 'create', object: 'campaign', values: { name: 'C', companies: [v] }, reason: 'r' })),
      linksChangeByCode: [secretRef, missRef].map(v => () => call('POST', 'changes', { action: 'create', object: 'campaign', values: { name: 'C', companies: [v] }, reason: 'r' })),
      linksChangeById: [secret, gone].map(v => () => call('POST', 'changes', { action: 'create', object: 'campaign', values: { name: 'C', companies: [v] }, reason: 'r' })),
      inboxResolveRecord: [secret, gone].map(id => () => call('POST', 'inbox/' + inboxId + '/resolve', { recordId: id })),
    };
    const out = {}; for (const [k, [a, b]] of Object.entries(pairs)) out[k] = { hit: s(await a()), miss: s(await b()) };
    const differ = Object.entries(out).filter(([, v]) => v.hit !== v.miss).map(([k]) => k);
    assert.deepEqual(differ, [], JSON.stringify(out)); return out;
  });
  await check('R2-O4', 3, 'Timing: capture of an unreadable existing company name vs a missing one (median of 25 each) differs by less than 5 ms', async () => {
    const { t, m, secretName } = await scoped('r2-o4'), times = { hit: [], miss: [] }, texts = { hit: new Set(), miss: new Set() };
    for (let i = 0; i < 25; i++) for (const k of ['hit', 'miss']) { const name = k === 'hit' ? secretName : 'Missing ' + randomUUID().slice(0, 6); const s = performance.now(); const r = await attempt(() => m.client.mutation(anyApi.capture.save, { orgId: t.orgId, kind: 'company', name })); times[k].push(performance.now() - s); texts[k].add(r.ok ? 'ok' : r.error.replace(name, '<v>')); }
    const out = { hitMs: +median(times.hit).toFixed(2), missMs: +median(times.miss).toFixed(2), hitOutcomes: [...texts.hit], missOutcomes: [...texts.miss] };
    assert.deepEqual(out.hitOutcomes, out.missOutcomes); assert.ok(Math.abs(out.hitMs - out.missMs) < 5, JSON.stringify(out)); return out;
  });
  await check('R2-O5', 3, 'Search ranking oracle: with limit 1, a query that also matches an unreadable record does not push the member/agent\'s own readable match out of the result', async () => {
    // Two identical workspaces; only one holds the unreadable "Bravo Charlie Delta". The caller searches "Alpha Bravo Charlie Delta".
    const run = async withSecret => {
      const { t, m } = await scoped('r2-o5-' + withSecret), c = await company(t);
      const mine = (await m.client.query(anyApi.records.search, { orgId: t.orgId, text: 'Alpha Mine', limit: 1 }))[0];
      if (withSecret) await makeRecord(t, 'company', 'Bravo Charlie Delta');
      const agent = await newAgent(t, { name: 'searcher', origin: 'external' }, true);
      await t.human.mutation(anyApi['authority/grants'].grant, { orgId: t.orgId, target: agent.agentId, capability: 'read', scope: { kind: 'records', objectId: c.object._id, records: [mine._id], fields: Object.values(c.fields).map(x => x._id) }, mode: 'direct', delegate: false, expiresAt: Date.now() + 300000 });
      const member = (await m.client.query(anyApi.records.search, { orgId: t.orgId, text: 'Alpha Bravo Charlie Delta', limit: 1 })).length;
      const memberObj = (await m.client.query(anyApi.records.search, { orgId: t.orgId, objectId: c.object._id, text: 'Alpha Bravo Charlie Delta', limit: 1 })).length;
      const r = await rest(agent.key)('GET', 'search?q=' + encodeURIComponent('Alpha Bravo Charlie Delta') + '&limit=1'); const agentN = r.status === 200 ? JSON.parse(r.text).length ?? JSON.parse(r.text).results?.length : r.status;
      return { member, memberObj, agent: agentN };
    };
    const out = { withSecret: await run(true), withoutSecret: await run(false) };
    assert.deepEqual(out.withSecret, out.withoutSecret, JSON.stringify(out)); return out;
  });
  await check('R2-O6', 3, 'Capture of a person whose company is an unreadable existing name behaves exactly like a missing company name', async () => {
    const { t, m, secretName } = await scoped('r2-o6');
    const go = async company => { const r = await attempt(() => m.client.mutation(anyApi.capture.save, { orgId: t.orgId, kind: 'person', name: 'Pat ' + randomUUID().slice(0, 4), company })); return r.ok ? 'ok ' + JSON.stringify(Object.keys(r.value ?? {})) : r.error.replace(company, '<v>'); };
    const out = { hit: await go(secretName), miss: await go('Missing ' + randomUUID().slice(0, 6)) };
    assert.equal(out.hit, out.miss, JSON.stringify(out)); return out;
  });

  // ================= Claim 3: readonly for the newly refused and operator-override functions =================
  await check('R2-R1', 3, 'Under readonly every operator/internal write behaves as its inventory label says, and refused ones change nothing', async () => {
    const t = await tenant('r2-r1'), legacyish = await newAgent(t, { name: 'pre', grants: [{ action: 'update', objectKey: 'company' }] });
    f.run('authorityFixtureIv:makeLegacy', { agentId: legacyish.agentId, grants: [{ action: 'update', objectKey: 'company' }] });
    f.run('ops:setFlag', { orgId: t.orgId, flag: 'readonly', enabled: true, reason: 'iv-r2' });
    const before = f.run('authorityFixtureIv:everything', { orgId: t.orgId });
    const refusedCalls = {
      'integrations/connections:registerSecret': () => runTry('integrations/connections:registerSecret', { orgId: t.orgId, provider: 'fake', environment: 'test', account: 'ro', handle: 'vault:' + randomUUID() }),
      'integrations/budgets:configure': () => runTry('integrations/budgets:configure', { orgId: t.orgId, cap: 99999, maxConcurrent: 99, maxPerRun: 99, maxSteps: 5, maxRecipients: 100 }),
      'seed:ensureStandard': () => runTry('seed:ensureStandard', { orgId: t.orgId }),
      'seed:backfillRefs': () => runTry('seed:backfillRefs', { orgId: t.orgId }),
      'seed:releaseStandardSlots': () => runTry('seed:releaseStandardSlots', { orgId: t.orgId }),
      'seed:demoAs': () => runTry('seed:demoAs', { orgId: t.orgId, userId: t.userId }),
      'agents:createAs': () => runTry('agents:createAs', { orgId: t.orgId, userId: t.userId, name: 'ro agent' }),
    };
    const out = { refused: {}, allowed: {} };
    for (const [id, go] of Object.entries(refusedCalls)) { const r = go(); out.refused[id] = { label: label(id), ok: r.ok, error: r.error }; }
    out.refused['integrations/connections:insert (via connect)'] = { label: label('integrations/connections:insert'), ...(await attempt(() => t.human.action(anyApi['integrations/connections'].connect, { orgId: t.orgId, secretReferenceId: t.secretReferenceId }))) }; delete out.refused['integrations/connections:insert (via connect)'].value;
    const after = f.run('authorityFixtureIv:everything', { orgId: t.orgId });
    out.unchanged = JSON.stringify(before) === JSON.stringify(after);
    // Operator overrides and reduction-only paths must still work under readonly.
    out.allowed['integrations/budgets:configure (global)'] = { label: 'outside-workspace', ok: runTry('integrations/budgets:configure', { cap: 100000, maxConcurrent: 1000, maxPerRun: 1000, maxSteps: 5, maxRecipients: 100 }).ok };
    out.allowed['integrations/budgets:clearAnomaly'] = { label: label('integrations/budgets:clearAnomaly'), ok: runTry('integrations/budgets:clearAnomaly', { orgId: t.orgId }).ok };
    out.allowed['authority/migration:freeze'] = { label: label('authority/migration:freeze'), ok: runTry('authority/migration:freeze', { orgId: t.orgId }).ok };
    const mig = runTry('authority/migration:migrateAgent', { agentId: legacyish.agentId }); out.allowed['authority/migration:migrateAgent'] = { label: label('authority/migration:migrateAgent'), ok: mig.ok, value: mig.value, error: mig.error };
    const migrated = f.run('authorityFixtureIv:everything', { orgId: t.orgId }).agents.find(a => a._id === legacyish.agentId);
    out.migratedGrants = migrated.grants.map(g => g.action + ':' + g.objectKey);
    out.allowed['ops:setFlag (lift readonly)'] = { label: label('ops:setFlag'), ok: runTry('ops:setFlag', { orgId: t.orgId, flag: 'readonly', enabled: false, reason: 'iv-r2' }).ok };
    const wrong = [...Object.entries(out.refused).filter(([, v]) => v.ok || v.label !== 'refused').map(([k]) => 'refused-row ' + k), ...Object.entries(out.allowed).filter(([, v]) => !v.ok).map(([k]) => 'allowed-row ' + k)];
    assert.deepEqual(wrong, [], JSON.stringify(out)); assert.ok(out.unchanged, 'refused calls changed workspace data'); assert.deepEqual(out.migratedGrants, ['update:company'], 'migration under readonly widened'); return out;
  });

  // ================= Claim 2: frozen object keys =================
  await check('R2-K1', 2, 'Legacy key grant follows the key the object had at freeze: swapping keys between two pre-freeze objects moves nothing, before and after migration', async () => {
    const t = await tenant('r2-k1'), c = await company(t), camp = await objectOf(t, 'campaign');
    const agent = await newAgent(t, { name: 'legacy', grants: [{ action: 'update', objectKey: 'campaign' }] });
    f.run('authorityFixtureIv:makeLegacy', { agentId: agent.agentId, grants: [{ action: 'update', objectKey: 'campaign' }] });
    const coRec = await makeRecord(t, 'company', 'Co'), campRec = await makeRecord(t, 'campaign', 'Camp');
    const upd = async id => (await rest(agent.key)('POST', 'changes', { action: 'update', record: id, values: { name: 'Upd' }, reason: 'r' })).status;
    const out = { before: { company: await upd(coRec), campaign: await upd(campRec) } };
    f.run('authorityFixtureIv:renameObject', { objectId: camp.object._id, key: 'tmpkey' }); f.run('authorityFixtureIv:renameObject', { objectId: c.object._id, key: 'campaign' }); f.run('authorityFixtureIv:renameObject', { objectId: camp.object._id, key: 'company' });
    out.swappedPreBackfill = { formerCompany: await upd(coRec), formerCampaign: await upd(campRec) };
    out.migrate = f.run('authority/migration:migrateAgent', { agentId: agent.agentId });
    out.swappedMigrated = { formerCompany: await upd(coRec), formerCampaign: await upd(campRec) };
    assert.equal(out.swappedPreBackfill.formerCompany, out.before.company, JSON.stringify(out)); assert.equal(out.swappedPreBackfill.formerCampaign, out.before.campaign, JSON.stringify(out));
    assert.equal(out.swappedMigrated.formerCompany, out.before.company, JSON.stringify(out)); assert.equal(out.swappedMigrated.formerCampaign, out.before.campaign, JSON.stringify(out)); return out;
  });

  // ================= Claim 1: the final-permit recheck without the sweep =================
  await check('R2-T1', 1, 'Without the pause sweep, the final permit alone refuses: approver downgraded (Approver authority changed) and delegated parent revoked (External capability denied)', async () => {
    const t = await tenant('r2-t1'), a = await invite(t, 'admin', 'approver');
    const id = await t.human.mutation(commands.proposeHuman, { orgId: t.orgId, logical: 'nosweep', bindingId: t.bindingId, capability: 'model.call', payload: t.payload, reservationUnits: 1, maxSteps: 1 });
    await a.client.mutation(commands.approve, { orgId: t.orgId, id, expiresAt: Date.now() + 60000 }); const c = await t.claim(id);
    f.run('authorityFixtureIv:setRoleNoSweep', { orgId: t.orgId, userId: a.userId, role: 'member' });
    const r1 = await adapterAs(t.adapterKey)('permit', { id, ...c, worker: 'worker' });
    assert.equal(r1.status, 403, r1.text); assert.match(r1.text, /Approver authority changed/);
    const manager = await newAgent(t, { name: 'manager', origin: 'external' }, true), child = await newAgent(t, { name: 'child', origin: 'external' }, true);
    await t.human.mutation(anyApi['authority/grants'].grant, { orgId: t.orgId, target: manager.agentId, capability: 'agent.manage', scope: { kind: 'agents', agents: [child.agentId] }, mode: 'direct', delegate: false, expiresAt: Date.now() + 60000 });
    const parent = await t.human.mutation(anyApi['authority/grants'].grant, { orgId: t.orgId, target: manager.agentId, capability: 'model.call', scope: { kind: 'model', maxUnitsPerRun: 5, maxSteps: 2 }, mode: 'direct', delegate: true, expiresAt: Date.now() + 60000 });
    const mg = await rest(manager.key)('POST', 'authority/grant', { target: child.agentId, capability: 'model.call', scope: { kind: 'model', maxUnitsPerRun: 5, maxSteps: 2 }, mode: 'direct', delegate: false, expiresAt: Date.now() + 30000, parent }); assert.equal(mg.status, 200, mg.text);
    const opR = await rest(child.key)('POST', 'operations', { logical: 'child', bindingId: t.bindingId, capability: 'model.call', payload: t.payload, reservationUnits: 1, maxSteps: 1 }); assert.equal(opR.status, 201, opR.text); const op = JSON.parse(opR.text);
    const ccR = await rest(child.key)('POST', 'operations/' + op + '/claim', { worker: 'w' }); assert.equal(ccR.status, 200, ccR.text); const cc = JSON.parse(ccR.text);
    f.run('authorityFixtureIv:revokeGrantNoSweep', { id: parent });
    const r2 = await adapterAs(t.adapterKey)('permit', { id: op, ...cc, worker: 'w' });
    assert.equal(r2.status, 403, r2.text); assert.match(r2.text, /External capability denied/);
    return { approver: r1.text, delegation: r2.text };
  });
  await check('R2-T2', 1, 'Real race, 20 rounds: role change via the public mutation, then permit at once; never 200, and record which layer refused', async () => {
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

  // ================= Claim 4: secret canaries across the whole run =================
  await check('R2-S1', 4, 'Across the whole r2 run, no raw agent key, raw adapter key or vault handle appears in the backend log', async () => {
    const handles = f.run('authorityFixtureIv:handles', {}), logs = f.logs();
    const out = { agentKeys: secrets.agentKeys.length, adapterKeys: secrets.adapterKeys.length, handles: handles.length, rawAgentKeyInLogs: secrets.agentKeys.filter(k => logs.includes(k)).length, rawAdapterKeyInLogs: secrets.adapterKeys.filter(k => logs.includes(k)).length, handleInLogs: handles.filter(h => logs.includes(h)).length, logBytes: logs.length };
    assert.equal(out.rawAgentKeyInLogs + out.rawAdapterKeyInLogs + out.handleInLogs, 0, JSON.stringify(out)); return out;
  });
  return { results, scratch: f.scratch };
});
writeFileSync(evidencePath('iv-r2.json'), JSON.stringify(report, null, 2) + '\n');
const r = report.results; console.log(`\nR2 SUMMARY ${r.filter(x => x.status === 'PASS').length} PASS / ${r.filter(x => x.status === 'FAIL').length} FAIL`);
