import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import inventory from './inventory.json' with { type: 'json' };
import { anyApi } from 'convex/server';
import { financial } from './service-fixture.mjs';

const request = (runtime, key, method, path, value) => fetch(runtime.site + path, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
const fn = id => { const [module, name] = id.split(':'); return anyApi[module][name]; };
const outcome = async call => { try { await call(); return 'allowed'; } catch (error) { const text = String(error?.message ?? error); return 'refused: ' + (/"message":"([^"]*)"/.exec(text)?.[1] ?? /(\w*Error: [^\n]*)/.exec(text)?.[1] ?? text.slice(0, 160)); } };

// Builds one synthetic workspace holding every kind of row a public write can target.
async function workspace(runtime, tenant, label) {
  const t = await tenant(label), objects = await t.human.query(anyApi.objects.list, { orgId: t.orgId });
  const company = objects.find(object => object.key === 'company'), detail = await t.human.query(anyApi.objects.get, { orgId: t.orgId, objectId: company._id });
  const [name, city] = ['name', 'city'].map(key => detail.fields.find(field => field.key === key));
  const record = (await t.human.mutation(anyApi.records.create, { orgId: t.orgId, objectId: company._id, values: { [name._id]: 'Sweep company' } })).recordId;
  const spare = (await t.human.mutation(anyApi.records.create, { orgId: t.orgId, objectId: company._id, values: { [name._id]: 'Spare company' } })).recordId;
  const agent = await t.human.action(anyApi.agents.create, { orgId: t.orgId, name: 'sweep agent', grants: ['create', 'update', 'delete'].map(action => ({ action, objectKey: 'company' })) });
  const target = await t.human.action(anyApi.agents.createScoped, { orgId: t.orgId, name: 'sweep target', origin: 'external' });
  const grantId = await t.human.mutation(anyApi['authority/grants'].grant, { orgId: t.orgId, target: target.agentId, capability: 'model.call', scope: { kind: 'model', maxUnitsPerRun: 1, maxSteps: 1 }, mode: 'direct', delegate: false, expiresAt: Date.now() + 600000 });
  const suggest = async value => (await (await request(runtime, agent.key, 'POST', '/api/v1/suggestions', { action: 'update', record, values: { name: value }, reason: 'sweep' })).json()).suggestion.id;
  const suggestions = { apply: await suggest('Suggested A'), dismiss: await suggest('Suggested B'), adopt: await suggest('Suggested C') };
  const inboxId = await t.human.mutation(anyApi.inbox.add, { orgId: t.orgId, text: 'Sweep note' });
  const memberClient = runtime.client('sweep-member-' + randomUUID()), memberUserId = await memberClient.mutation(anyApi.users.store, {});
  const invite = await t.human.mutation(anyApi.invites.create, { orgId: t.orgId, role: 'member' }); await memberClient.mutation(anyApi.invites.accept, { token: invite.token });
  const leaver = runtime.client('sweep-leaver-' + randomUUID()); await leaver.mutation(anyApi.users.store, {}); const leaveInvite = await t.human.mutation(anyApi.invites.create, { orgId: t.orgId, role: 'member' }); await leaver.mutation(anyApi.invites.accept, { token: leaveInvite.token });
  const pendingInvite = await t.human.mutation(anyApi.invites.create, { orgId: t.orgId, role: 'member' }), joiner = runtime.client('sweep-joiner-' + randomUUID()); await joiner.mutation(anyApi.users.store, {});
  const members = await t.human.query(anyApi.orgs.members, { orgId: t.orgId }), ownerMember = members.find(row => row.user._id === t.userId).member;
  const queued = await t.propose('sweep-queued', 1, 1), unknownOp = await t.propose('sweep-unknown', 1, 1), unknownTarget = await t.start(unknownOp); await t.adapter('unknown', unknownTarget);
  const author = await t.human.action(anyApi.agents.createScoped, { orgId: t.orgId, name: 'sweep fired author', origin: 'external' });
  await t.human.mutation(anyApi['authority/grants'].grant, { orgId: t.orgId, target: author.agentId, capability: 'model.call', scope: { kind: 'model', maxUnitsPerRun: 1, maxSteps: 1 }, mode: 'direct', delegate: false, expiresAt: Date.now() + 600000 });
  const orphan = await (await request(runtime, author.key, 'POST', '/api/v1/operations', { logical: 'orphan', bindingId: t.bindingId, capability: 'model.call', payload: t.payload, reservationUnits: 1, maxSteps: 1 })).json();
  await t.human.mutation(anyApi.agents.revoke, { orgId: t.orgId, agentId: author.agentId });
  const claimer = await t.human.action(anyApi.agents.createScoped, { orgId: t.orgId, name: 'sweep claimer', origin: 'external' });
  await t.human.mutation(anyApi['authority/grants'].grant, { orgId: t.orgId, target: claimer.agentId, capability: 'model.call', scope: { kind: 'model', maxUnitsPerRun: 1, maxSteps: 1 }, mode: 'direct', delegate: false, expiresAt: Date.now() + 600000 });
  const claimerOp = await (await request(runtime, claimer.key, 'POST', '/api/v1/operations', { logical: 'claimer-op', bindingId: t.bindingId, capability: 'model.call', payload: t.payload, reservationUnits: 1, maxSteps: 1 })).json();
  const secondSecret = runtime.run('integrations/connections:registerSecret', { orgId: t.orgId, provider: 'fake', environment: 'test', account: 'sweep-second-' + randomUUID(), handle: 'vault:' + randomUUID() });
  const money = await financial(t);
  return { t, claimer, claimerOp, leaver, orphan, company, name, city, record, spare, agent, target, grantId, suggestions, inboxId, memberClient, memberUserId, pendingInvite, joiner, ownerMember, queued, unknownOp, unknownTarget, secondSecret, money };
}

export async function replaySweeps({ runtime, tenant, test }) {
  await test('Readonly workspace refuses every public human write and every agent REST write', async () => {
    const w = await workspace(runtime, tenant, 'readonly-sweep'), { t } = w, orgId = t.orgId;
    const human = {
      'agents:create': () => t.human.action(fn('agents:create'), { orgId, name: 'denied', grants: [] }),
      'agents:createScoped': () => t.human.action(fn('agents:createScoped'), { orgId, name: 'denied', origin: 'external' }),
      'agents:setGrants': () => t.human.mutation(fn('agents:setGrants'), { orgId, agentId: w.agent.agentId, grants: [{ action: 'create', objectKey: 'person' }] }),
      'agents:setSharedInbox': () => t.human.mutation(fn('agents:setSharedInbox'), { orgId, agentId: w.agent.agentId, enabled: true }),
      'agents:revoke': () => t.human.mutation(fn('agents:revoke'), { orgId, agentId: w.target.agentId }),
      'authority/grants:grant': () => t.human.mutation(fn('authority/grants:grant'), { orgId, target: w.target.agentId, capability: 'model.call', scope: { kind: 'model', maxUnitsPerRun: 1, maxSteps: 1 }, mode: 'direct', delegate: false, expiresAt: Date.now() + 60000 }),
      'authority/grants:revoke': () => t.human.mutation(fn('authority/grants:revoke'), { orgId, id: w.grantId }),
      'authority/policies:setMember': () => t.human.mutation(fn('authority/policies:setMember'), { orgId, memberId: w.ownerMember._id, hiddenFieldIds: [] }),
      'authority/policies:setAgentMasks': () => t.human.mutation(fn('authority/policies:setAgentMasks'), { orgId, agentId: w.agent.agentId, hiddenFieldIds: [] }),
      'capture:save': () => t.human.mutation(fn('capture:save'), { orgId, kind: 'company', name: 'Denied capture' }),
      'csv:importRows': () => t.human.mutation(fn('csv:importRows'), { orgId, objectId: w.company._id, columns: [w.name._id], rows: [['Denied import']], firstRow: 1, skipDuplicates: false, createMissing: false }),
      'fields:create': () => t.human.mutation(fn('fields:create'), { orgId, objectId: w.company._id, key: 'denied', label: 'Denied', type: 'text' }),
      'fields:update': () => t.human.mutation(fn('fields:update'), { orgId, fieldId: w.city._id, label: 'Denied' }),
      'fields:retire': () => t.human.mutation(fn('fields:retire'), { orgId, fieldId: w.city._id }),
      'inbox:add': () => t.human.mutation(fn('inbox:add'), { orgId, text: 'Denied note' }),
      'inbox:remove': () => t.human.mutation(fn('inbox:remove'), { orgId, id: w.inboxId }),
      'integrations/bindings:provision': () => t.human.mutation(fn('integrations/bindings:provision'), { orgId, connectionId: t.connectionId, logical: 'denied', kind: 'model', remove: false }),
      'integrations/commands:proposeHuman': () => t.human.mutation(fn('integrations/commands:proposeHuman'), { orgId, logical: 'denied', bindingId: t.bindingId, capability: 'model.call', payload: t.payload, reservationUnits: 1, maxSteps: 1 }),
      'integrations/commands:editHuman': () => t.human.mutation(fn('integrations/commands:editHuman'), { orgId, id: w.queued, payload: { ...t.payload, content: 'denied edit' } }),
      'integrations/commands:approve': () => t.human.mutation(fn('integrations/commands:approve'), { orgId, id: w.queued, expiresAt: Date.now() + 60000 }),
      'integrations/commands:claimHuman': () => t.human.mutation(fn('integrations/commands:claimHuman'), { orgId, id: w.queued, worker: 'denied' }),
      'integrations/commands:cancelHuman': () => t.human.mutation(fn('integrations/commands:cancelHuman'), { orgId, id: w.queued }),
      'integrations/commands:adopt': () => t.human.mutation(fn('integrations/commands:adopt'), { orgId, id: w.orphan, logical: 'denied-adopt' }),
      'integrations/connections:connect': () => t.human.action(fn('integrations/connections:connect'), { orgId, secretReferenceId: w.secondSecret }),
      'integrations/connections:disconnect': () => t.human.mutation(fn('integrations/connections:disconnect'), { orgId, connectionId: t.connectionId }),
      'integrations/outcomes:operatorResolveUnknown': () => t.human.mutation(fn('integrations/outcomes:operatorResolveUnknown'), { orgId, id: w.unknownOp, fence: w.unknownTarget.fence, step: w.unknownTarget.step, finality: 'provisional', evidence: 'synthetic operator review' }),
      'integrations/safety:prepare': () => t.human.mutation(fn('integrations/safety:prepare'), { orgId, targetId: w.money.targetId, logical: 'readonly-refund', kind: 'refund', amountMinor: 1 }),
      'integrations/safety:consume': async () => { const id = await t.human.mutation(fn('integrations/safety:prepare'), { orgId, targetId: w.money.targetId, logical: 'readonly-refund-consume', kind: 'refund', amountMinor: 1 }); return t.human.mutation(fn('integrations/safety:consume'), { orgId, id }); },
      'invites:create': () => t.human.mutation(fn('invites:create'), { orgId, role: 'member' }),
      'invites:accept': () => w.joiner.mutation(fn('invites:accept'), { token: w.pendingInvite.token }),
      'objects:create': () => t.human.mutation(fn('objects:create'), { orgId, key: 'denied', label: 'Denied', labelPlural: 'Denied' }),
      'orgs:rename': () => t.human.mutation(fn('orgs:rename'), { orgId, name: 'Denied rename' }),
      'orgs:setRole': () => t.human.mutation(fn('orgs:setRole'), { orgId, userId: w.memberUserId, role: 'admin' }),
      'orgs:removeMember': () => t.human.mutation(fn('orgs:removeMember'), { orgId, userId: w.memberUserId }),
      'orgs:leave': () => w.leaver.mutation(fn('orgs:leave'), { orgId }),
      'records:create': () => t.human.mutation(fn('records:create'), { orgId, objectId: w.company._id, values: { [w.name._id]: 'Denied record' } }),
      'records:update': () => t.human.mutation(fn('records:update'), { orgId, recordId: w.record, values: { [w.name._id]: 'Denied update' } }),
      'records:remove': () => t.human.mutation(fn('records:remove'), { orgId, recordId: w.spare }),
      'seed:demo': () => t.human.mutation(fn('seed:demo'), { orgId }),
      'suggestions:apply': () => t.human.mutation(fn('suggestions:apply'), { orgId, suggestionId: w.suggestions.apply }),
      'suggestions:dismiss': () => t.human.mutation(fn('suggestions:dismiss'), { orgId, suggestionId: w.suggestions.dismiss }),
      'suggestions:adopt': () => t.human.mutation(fn('suggestions:adopt'), { orgId, suggestionId: w.suggestions.adopt }),
    };
    const rest = {
      'HTTP POST /api/v1/changes': ['/api/v1/changes', { action: 'create', object: 'company', values: { name: 'Denied' }, reason: 'readonly sweep' }],
      'HTTP POST /api/v1/suggestions': ['/api/v1/suggestions', { action: 'create', object: 'company', values: { name: 'Denied proposal' }, reason: 'readonly sweep' }],
      'HTTP POST /api/v1/inbox': ['/api/v1/inbox', { text: 'Denied inbox' }],
      'HTTP POST /api/v1/inbox/:id/resolve': ['/api/v1/inbox/' + w.inboxId + '/resolve', { note: 'Denied resolve' }],
      'HTTP POST /api/v1/operations': ['/api/v1/operations', { key: 'claimer', logical: 'readonly-' + randomUUID(), bindingId: t.bindingId, capability: 'model.call', payload: t.payload, reservationUnits: 1, maxSteps: 1 }],
      'HTTP POST /api/v1/operations/:id/edit': ['/api/v1/operations/' + w.claimerOp + '/edit', { key: 'claimer', payload: { ...t.payload, content: 'denied edit' } }],
      'HTTP POST /api/v1/operations/:id/claim': ['/api/v1/operations/' + w.claimerOp + '/claim', { key: 'claimer', worker: 'readonly-agent' }],
      'HTTP POST /api/v1/authority/grant': ['/api/v1/authority/grant', { target: w.target.agentId, capability: 'model.call', scope: { kind: 'model', maxUnitsPerRun: 1, maxSteps: 1 }, mode: 'direct', delegate: false, expiresAt: Date.now() + 60000 }],
    };
    const declared = inventory.filter(entry => entry.visibility === 'public' && entry.writes && ['refused', 'reduction-only', 'settlement-allowed'].includes(entry.readonly));
    for (const entry of declared) assert.ok(human[entry.id], 'No readonly sweep call for ' + entry.id);
    for (const entry of inventory.filter(entry => entry.visibility === 'http' && entry.writes && entry.principal === 'agent' && entry.readonly === 'refused')) assert.ok(rest[entry.id], 'No readonly sweep call for ' + entry.id);
    runtime.run('authorityFixture:flags', { orgId, readonly: true });
    const observed = {};
    if (process.env.I1_OBSERVE) { for (const entry of declared) observed[entry.id] = await outcome(human[entry.id]); console.log('OBSERVE', JSON.stringify(observed, null, 1)); return; }
    // Refusals first: each must leave every org-scoped table unchanged.
    for (const entry of declared.filter(entry => entry.readonly === 'refused')) {
      const before = runtime.run('authorityFixtureSweeps:everything', { orgId });
      observed[entry.id] = await outcome(human[entry.id]);
      assert.match(observed[entry.id], /read only|Read only/, entry.id + ' must refuse while readonly: ' + observed[entry.id]);
      assert.deepEqual(runtime.run('authorityFixtureSweeps:everything', { orgId }), before, entry.id + ' changed data while readonly');
    }
    for (const [id, [path, { key, ...value }]] of Object.entries(rest)) {
      const before = runtime.run('authorityFixtureSweeps:everything', { orgId }), response = await request(runtime, key === 'claimer' ? w.claimer.key : w.agent.key, 'POST', path, value), text = await response.text();
      observed[id] = response.status + ' ' + text.slice(0, 160);
      assert.equal(response.status, 403, id + ' must refuse readonly writes: ' + text); assert.match(text, /read only/, id);
      assert.deepEqual(runtime.run('authorityFixtureSweeps:everything', { orgId }), before, id + ' changed data while readonly');
    }
    // Reductions and safety settlement stay available by design (see ops/authority/metadata.test.ts and safety tests).
    // Settlement first: reductions such as disconnect or revoke would otherwise stop it for unrelated reasons.
    for (const entry of [...declared.filter(entry => entry.readonly === 'settlement-allowed'), ...declared.filter(entry => entry.readonly === 'reduction-only')]) {
      observed[entry.id] = await outcome(human[entry.id]);
      assert.equal(observed[entry.id], 'allowed', entry.id + ' is declared ' + entry.readonly + ' but was ' + observed[entry.id]);
    }
    // An agent may still stop its own queued work while the workspace is readonly.
    const cancelled = await request(runtime, w.claimer.key, 'POST', '/api/v1/operations/' + w.claimerOp + '/cancel', {}); observed['HTTP POST /api/v1/operations/:id/cancel'] = cancelled.status + ' ' + (await cancelled.text()).slice(0, 120);
    assert.equal(cancelled.status, 200, 'agent cancel is a reduction and stays available');
    console.log('READONLY SWEEP', JSON.stringify(observed));
  });

  await test('Hidden field value never appears in any human query or agent REST read', async () => {
    const w = await workspace(runtime, tenant, 'mask-sweep'), { t } = w, orgId = t.orgId, canary = 'MASK-' + randomUUID();
    // The canary lands in a record value, its history, and an agent suggestion before the field is hidden.
    await t.human.mutation(anyApi.records.update, { orgId, recordId: w.record, values: { [w.city._id]: canary } });
    await request(runtime, w.agent.key, 'POST', '/api/v1/suggestions', { action: 'update', record: w.record, values: { city: canary + '-proposed' }, reason: 'sweep' });
    await t.human.mutation(anyApi['authority/policies'].setAgentMasks, { orgId, agentId: w.agent.agentId, hiddenFieldIds: [w.city._id] });
    await t.human.mutation(anyApi['authority/policies'].setMember, { orgId, memberId: w.ownerMember._id, hiddenFieldIds: [w.city._id] });
    const record = await t.human.query(anyApi.records.get, { orgId, recordId: w.record }), page = { cursor: null, numItems: 50 };
    const person = (await t.human.query(anyApi.objects.list, { orgId })).find(object => object.key === 'person'), personFields = await t.human.query(anyApi.fields.list, { orgId, objectId: person._id });
    const reverse = personFields.find(field => field.key === 'company');
    const queries = {
      'agents:list': { orgId }, 'csv:exportPage': { orgId, objectId: w.company._id, cursor: null }, 'events:forRecord': { orgId, recordId: w.record }, 'events:forOrg': { orgId, paginationOpts: page },
      'fields:list': { orgId, objectId: w.company._id }, 'inbox:audience': { orgId }, 'inbox:list': { orgId }, 'integrations/commands:getHuman': { orgId, id: w.queued }, 'integrations/connections:list': { orgId },
      'invites:get': { token: w.pendingInvite.token }, 'objects:list': { orgId }, 'objects:get': { orgId, objectId: w.company._id }, 'orgs:mine': {}, 'orgs:get': { orgId }, 'orgs:members': { orgId },
      'records:list': { orgId, objectId: w.company._id, paginationOpts: page }, 'records:get': { orgId, recordId: w.record }, 'records:related': { orgId, recordId: w.record, fieldId: reverse._id, paginationOpts: page },
      'records:reverseFields': { orgId, objectId: w.company._id }, 'records:byRef': { orgId, ref: record.ref ?? 'none' }, 'records:search': { orgId, text: canary }, 'suggestions:list': { orgId }, 'suggestions:forRecord': { orgId, recordId: w.record },
      'today:get': { orgId, today: Date.now() }, 'users:me': {},
    };
    for (const entry of inventory.filter(entry => entry.visibility === 'public' && entry.kind === 'query')) {
      assert.ok(queries[entry.id], 'No mask sweep call for ' + entry.id);
      const result = await t.human.query(fn(entry.id), queries[entry.id]);
      assert.ok(!JSON.stringify(result).includes(canary), entry.id + ' leaked a hidden field value');
    }
    const gets = ['me', 'objects', 'records?object=company', 'records/' + w.record, 'records/' + w.record + '/events', 'records/' + w.record + '/related?field=person.company', 'search?q=' + canary, 'search?q=Sweep', 'today', 'suggestions', 'inbox'];
    for (const path of gets) {
      const response = await request(runtime, w.agent.key, 'GET', '/api/v1/' + path), text = await response.text();
      assert.ok(response.status < 500, path + ' failed: ' + text); assert.ok(!text.includes(canary), path + ' leaked a hidden field value');
    }
  });

  await test('Operator-internal and adapter paths behave under readonly exactly as the inventory labels them', async () => {
    const w = await workspace(runtime, tenant, 'internal-sweep'), { t } = w, orgId = t.orgId;
    const legacyAgent = w.agent.agentId;
    const cli = (fn, args) => () => runtime.run(fn, args);
    const adapter = (name, body) => async () => { const r = await request(runtime, t.adapterKey, 'POST', '/api/integrations/v1/' + name, body); if (!r.ok) throw new Error(r.status + ' ' + await r.text()); };
    const intentId = await t.human.mutation(anyApi['integrations/bindings'].provision, { orgId, connectionId: t.connectionId, logical: 'late-bind', kind: 'model', remove: false });
    const recipientIntent = await t.human.mutation(anyApi['integrations/bindings'].provision, { orgId, connectionId: t.connectionId, logical: 'sweep-recipient', recipient: 'sweep-recipient', kind: 'recipient', remove: false });
    const recipientBinding = (await (await request(runtime, t.adapterKey, 'POST', '/api/integrations/v1/bind', { intentId: recipientIntent, externalId: 'sweep-recipient' })).json()).bindingId;
    const cursorArgs = { resource: 'sweep', traversal: 'one', from: 0, page: 1, items: [], end: true, checkpoint: 1 };
    const calls = {
      'integrations/connections:registerSecret': cli('integrations/connections:registerSecret', { orgId, provider: 'fake', environment: 'test', account: 'ro-' + randomUUID(), handle: 'vault:' + randomUUID() }),
      'integrations/budgets:configure': cli('integrations/budgets:configure', { orgId, cap: 11, maxConcurrent: 3, maxPerRun: 8, maxSteps: 3, maxRecipients: 10 }),
      'seed:ensureStandard': cli('seed:ensureStandard', { orgId }),
      'seed:backfillRefs': cli('seed:backfillRefs', { orgId }),
      'seed:releaseStandardSlots': cli('seed:releaseStandardSlots', { orgId }),
      'seed:demoAs': cli('seed:demoAs', { orgId, userId: t.userId }),
      'agents:createAs': cli('agents:createAs', { orgId, userId: t.userId, name: 'denied' }),
      'authority/migration:freeze': cli('authority/migration:freeze', { orgId }),
      'authority/migration:migrateAgent': cli('authority/migration:migrateAgent', { agentId: legacyAgent }),
      'integrations/budgets:clearAnomaly': cli('integrations/budgets:clearAnomaly', { orgId }),
      'integrations/connections:registerProvider': cli('integrations/connections:registerProvider', { provider: 'fake', enabled: true }),
      'HTTP POST /api/integrations/v1/bind': adapter('bind', { intentId, externalId: 'late-bind' }),
      'HTTP POST /api/integrations/v1/page': adapter('page', cursorArgs),
      'HTTP POST /api/integrations/v1/callback': adapter('callback', { bindingId: recipientBinding, eventId: 'ro', body: '{"version":1,"state":"suppressed","channel":"email","purpose":"marketing"}' }),
      // Last, because it lifts the hold.
      'ops:setFlag': cli('ops:setFlag', { orgId, flag: 'readonly', enabled: false, reason: 'sweep:lift' }),
    };
    runtime.run('authorityFixture:flags', { orgId, readonly: true });
    const observed = {};
    for (const [id, call] of Object.entries(calls)) {
      const row = inventory.find(entry => entry.id === id); assert.ok(row, 'inventory row missing for ' + id);
      let text; try { await call(); text = 'allowed'; } catch (error) { text = 'refused: ' + String(error?.stderr || error?.message || error).slice(0, 300); }
      observed[id] = text;
      if (row.readonly === 'refused') assert.match(text, /read only/, id + ' is labelled refused but was: ' + text.slice(0, 200));
      else assert.equal(text, 'allowed', id + ' is labelled ' + row.readonly + ' but was: ' + text.slice(0, 200));
    }
    assert.equal((await t.human.query(anyApi.orgs.get, { orgId })).flags?.readonly, false, 'ops:setFlag lifts readonly');
    console.log('INTERNAL READONLY SWEEP', JSON.stringify(observed));
  });
}
