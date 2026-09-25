import assert from 'node:assert/strict';
import { anyApi } from 'convex/server';
import { cpSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Client } from '../../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { withAuthority, evidencePath } from './local.mjs';
const report = await withAuthority(async f => {
  const human = f.client('migration-owner'); await human.mutation(anyApi.users.store, {}); const orgId = await human.mutation(anyApi.orgs.create, { name: 'Authority migration synthetic' });
  const legacy = await human.action(anyApi.agents.create, { orgId, name: 'Retained legacy agent', role: 'admin', grants: ['create', 'update', 'delete'].map(action => ({ action, objectKey: '*' })) });
  const objects = await human.query(anyApi.objects.list, { orgId }), company = objects.find(o => o.key === 'company');
  const keys = objects.map(o => o.key).sort(), transcript = [];
  const rest = async (method, path, body) => { const response = await fetch(f.site + '/api/v1/' + path, { method, headers: { authorization: 'Bearer ' + legacy.key, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = text; } return { status: response.status, data }; };
  const archive = execFileSync('git', ['archive', '3339517', 'packages/mcp/src', 'packages/mcp/tsconfig.json', 'packages/mcp/package.json'], { cwd: f.root });
  execFileSync('tar', ['-x', '-C', f.scratch], { input: archive });
  const oldMcp = join(f.scratch, 'packages/mcp');
  symlinkSync(join(f.root, 'packages/mcp/node_modules'), join(oldMcp, 'node_modules'), 'dir');
  execFileSync(join(f.root, 'packages/mcp/node_modules/.bin/tsc'), ['-p', join(oldMcp, 'tsconfig.json')], { cwd: oldMcp, stdio: 'pipe' });
  const mcp = new Client({ name: 'retained-authority-migration-client', version: '1' });
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [join(oldMcp, 'dist/index.js')], env: { PATH: process.env.PATH, REMOLD_URL: f.site, REMOLD_KEY: legacy.key }, stderr: 'pipe' }));
  const call = async (phase, name, args = {}) => { const response = await mcp.callTool({ name, arguments: args }); assert.ok(!response.isError, JSON.stringify(response)); const data = JSON.parse(response.content[0].text); transcript.push({ phase, name, args, data }); return data; };
  const refusedMcp = async (name, args) => {
    const response = await mcp.callTool({ name, arguments: args });
    assert.equal(response.isError, true, JSON.stringify(response));
  };
  function normalize(value, ids = {}) {
    if (Array.isArray(value)) return value.map(x => normalize(x, ids));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !['_creationTime', 'updatedAt', 'createdAt', 'appliedAt', 'objectId'].includes(k)).map(([k, v]) => [k, k === 'grants' ? [...new Set(v.flatMap(g => (g.objectKey === '*' ? keys : [g.objectKey]).map(key => g.action + ':' + key)))].sort() : normalize(v, ids)]));
    return typeof value === 'string' && ids[value] ? ids[value] : value;
  }
  const exercise = async phase => {
    const me = await call(phase, 'remold_me'), metadata = await call(phase, 'remold_objects');
    const created = await call(phase, 'remold_apply_change', { action: 'create', object: 'company', values: { name: 'Compatibility company' }, reason: 'synthetic compatibility' });
    const id = created.record.id, reference = created.record.ref, ids = { [id]: '<record>', [reference]: '<ref>' };
    await call(phase, 'remold_apply_change', { action: 'update', record: id, values: { city: 'Synthetic city' }, reason: 'synthetic compatibility' });
    const got = await call(phase, 'remold_get_record', { idOrRef: reference });
    const listed = await call(phase, 'remold_list_records', { object: 'company' }), searched = await call(phase, 'remold_search', { q: 'Compatibility', object: 'company' });
    const related = await call(phase, 'remold_related', { idOrRef: id, field: 'person.company' }), today = await call(phase, 'remold_today');
    const proposal = await call(phase, 'remold_propose_change', { action: 'update', record: id, values: { name: 'Proposed company' }, reason: 'synthetic compatibility' }); ids[proposal.suggestion.id] = '<suggestion>';
    const suggestions = await call(phase, 'remold_list_suggestions', { status: 'pending' });
    const inbox = await call(phase, 'remold_inbox_add', { text: 'Compatibility inbox', source: 'synthetic' }); const inboxId = inbox.id ?? inbox.item?.id ?? inbox.inbox?.id; assert.ok(inboxId, JSON.stringify(inbox)); ids[inboxId] = '<inbox>';
    const pending = await call(phase, 'remold_inbox'); await call(phase, 'remold_inbox_resolve', { id: inboxId, recordId: id, note: 'resolved' });
    const restGet = await rest('GET', 'records/' + id), restList = await rest('GET', 'records?object=company'); assert.equal(restGet.status, 200); assert.equal(restList.status, 200);
    await human.mutation(anyApi.suggestions.dismiss, { orgId, suggestionId: proposal.suggestion.id }); await call(phase, 'remold_apply_change', { action: 'delete', record: id, reason: 'synthetic compatibility cleanup' });
    const stripEvents = { ...got, events: got.events.map(({ at, ...event }) => ({ ...event, id: '<event>' })) };
    return normalize({ me, metadata, got: stripEvents, listed, searched, related, today, suggestions, pending, restGet: { ...restGet.data, events: restGet.data.events.map(({ at, ...event }) => ({ ...event, id: '<event>' })) }, restList: restList.data }, ids);
  };
  const assertFutureRefused = async (phase, futureRecordId, bindingId, victimId) => {
    const before = f.run('authorityFixture:snapshot', { orgId });
    const create = await rest('POST', 'changes', { action: 'create', object: 'future', values: { name: 'denied' }, reason: 'scope ceiling' });
    const update = await rest('POST', 'changes', { action: 'update', record: futureRecordId, values: { name: 'denied update' }, reason: 'scope ceiling' });
    const remove = await rest('POST', 'changes', { action: 'delete', record: futureRecordId, reason: 'scope ceiling' });
    const deleteRoute = await rest('DELETE', 'records/' + futureRecordId);
    const listed = await rest('GET', 'records?object=future');
    const got = await rest('GET', 'records/' + futureRecordId);
    const grant = await rest('POST', 'authority/grant', { target: victimId, capability: 'agent.manage', scope: { kind: 'agents', agents: [victimId] }, mode: 'direct', delegate: false, expiresAt: Date.now() + 60_000 });
    const fire = await rest('POST', 'authority/fire', { target: victimId });
    const operation = await rest('POST', 'operations', { logical: 'denied-external-effect', bindingId, capability: 'marketing.send', payload: { content: 'synthetic', audience: [], audienceVersion: 1, destination: 'migration', schedule: 0, amountMinor: 0, currency: 'USD', workflowVersion: 1 }, reservationUnits: 1, maxSteps: 1 });
    assert.equal(create.status, 403, phase + ' create'); assert.equal(update.status, 403, phase + ' update'); assert.equal(remove.status, 403, phase + ' delete');
    assert.equal(deleteRoute.status, 404, phase + ' DELETE route'); assert.equal(listed.status, 404, phase + ' list'); assert.equal(got.status, 404, phase + ' get');
    assert.equal(grant.status, 403, phase + ' agent.manage'); assert.equal(fire.status, 403, phase + ' fire'); assert.equal(operation.status, 403, phase + ' external-effect proposal');
    await refusedMcp('remold_apply_change', { action: 'create', object: 'future', values: { name: 'denied MCP' }, reason: 'scope ceiling' });
    await refusedMcp('remold_propose_change', { action: 'create', object: 'future', values: { name: 'denied MCP proposal' }, reason: 'scope ceiling' });
    assert.deepEqual(f.run('authorityFixture:snapshot', { orgId }), before, phase + ' refusals leave the database unchanged');
  };
  try {
    const baselineSchema = readFileSync(join(f.scratch, 'convex/schema.ts'), 'utf8'), baseline = await exercise('baseline');
    const baselineSnapshot = f.run('authorityFixture:snapshot', { orgId });
    assert.equal(baselineSnapshot.agents[0].authorityVersion, undefined);
    // R0 expands only validators and installs the idempotent freeze/backfill entrypoints.
    await f.reload(() => {
      for (const path of ['convex/schema.ts', 'convex/errors.ts', 'convex/integrations/tables.ts', 'convex/authority/migration.ts']) { mkdirSync(join(f.scratch, path, '..'), { recursive: true }); cpSync(join(f.root, path), join(f.scratch, path)); }
    });
    const cutoff = f.run('authority/migration:freeze', { orgId }); assert.equal(f.run('authority/migration:freeze', { orgId }), cutoff);
    const expandedAuth = readFileSync(join(f.scratch, 'convex/auth.config.ts'), 'utf8');
    await f.reload(() => {
      cpSync(join(f.root, 'convex'), join(f.scratch, 'convex'), { recursive: true, filter: p => !p.endsWith('.test.ts') && !p.endsWith('test.helpers.ts') && !p.endsWith('test.setup.ts') && !p.endsWith('auth.config.ts') });
      writeFileSync(join(f.scratch, 'convex/auth.config.ts'), expandedAuth);
    });
    const fallback = await exercise('enforcing-expand-before-backfill'); assert.deepEqual(fallback, baseline);
    const expandedSchema = readFileSync(join(f.scratch, 'convex/schema.ts'), 'utf8');
    const futureId = await human.mutation(anyApi.objects.create, { orgId, key: 'future', label: 'Future', labelPlural: 'Future' });
    const futureName = (await human.query(anyApi.objects.get, { orgId, objectId: futureId })).fields.find(field => field.key === 'name');
    const future = await human.mutation(anyApi.records.create, { orgId, objectId: futureId, values: { [futureName._id]: 'Human future record' } });
    const victim = await human.action(anyApi.agents.create, { orgId, name: 'Management target', grants: [] });
    f.run('integrations/connections:registerProvider', { provider: 'fake', enabled: true });
    const secretReferenceId = f.run('integrations/connections:registerSecret', { orgId, provider: 'fake', environment: 'test', account: 'migration', handle: 'vault:00000000-0000-0000-0000-000000000002' });
    const connection = await human.action(anyApi['integrations/connections'].connect, { orgId, secretReferenceId });
    const provisioned = await human.mutation(anyApi['integrations/bindings'].provision, { orgId, connectionId: connection.connectionId, logical: 'migration', kind: 'marketing', remove: false });
    const bindingResponse = await fetch(f.site + '/api/integrations/v1/bind', { method: 'POST', headers: { authorization: 'Bearer ' + connection.adapterKey, 'content-type': 'application/json' }, body: JSON.stringify({ intentId: provisioned, externalId: 'migration-binding' }) });
    assert.equal(bindingResponse.status, 200); const { bindingId } = await bindingResponse.json();
    // Frozen but not yet backfilled: the legacy wildcard is evaluated against the freeze cutoff.
    await assertFutureRefused('frozen-before-backfill', future.recordId, bindingId, victim.agentId);
    const first = f.run('authority/migration:migrateAgent', { agentId: legacy.agentId }); assert.equal(first.changed, true); assert.equal(f.run('authority/migration:migrateAgent', { agentId: legacy.agentId }).changed, false);
    const after = await exercise('migrated'); assert.deepEqual(after, baseline);
    const migratedSnapshot = f.run('authorityFixture:snapshot', { orgId }); assert.equal(migratedSnapshot.agents[0].keyHash, baselineSnapshot.agents[0].keyHash); assert.equal(migratedSnapshot.agents[0].role, baselineSnapshot.agents[0].role); assert.ok(!migratedSnapshot.agents[0].readObjectIds.includes(futureId));
    await assertFutureRefused('migrated', future.recordId, bindingId, victim.agentId);
    const current = await human.action(anyApi.agents.create, { orgId, name: 'Current-object agent', grants: [{ action: 'create', objectKey: '*' }] });
    const currentRest = async (path, body) => fetch(f.site + '/api/v1/' + path, { method: 'POST', headers: { authorization: 'Bearer ' + current.key, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await currentRest('changes', { action: 'create', object: 'future', values: { name: 'Current object allowed' }, reason: 'synthetic frozen scope' })).status, 200);
    await human.mutation(anyApi.objects.create, { orgId, key: 'later', label: 'Later', labelPlural: 'Later' });
    assert.equal((await currentRest('changes', { action: 'create', object: 'later', values: { name: 'Later denied' }, reason: 'synthetic frozen scope' })).status, 403);
    const schemaFailure = await f.reload(() => writeFileSync(join(f.scratch, 'convex/schema.ts'), baselineSchema), true);
    await f.reload(() => writeFileSync(join(f.scratch, 'convex/schema.ts'), expandedSchema));
    const rollback = await exercise('compatible-enforcing-rollback'); assert.deepEqual(rollback, baseline);
    await assertFutureRefused('compatible-enforcing-rollback', future.recordId, bindingId, victim.agentId);
    f.run('authorityFixture:keyReuse', { objectId: company._id, key: 'old-company' });
    await human.mutation(anyApi.objects.create, { orgId, key: 'company', label: 'Replacement company', labelPlural: 'Replacement companies' });
    assert.equal((await rest('POST', 'changes', { action: 'create', object: 'company', values: { name: 'key reuse denied' }, reason: 'identity ceiling' })).status, 403);
    return { status: 'PASS bounded migration and old-client compatibility', level: 'SERVICE local backend / synthetic JWT and data', baselineRevision: '3339517', oldMcpHash: f.sha(readFileSync(join(oldMcp, 'dist/index.js'))), cutoff, baselineSnapshot, migratedSnapshot, transcript, normalizedTranscript: { baseline, fallback, after, rollback }, schemaFailure, fixture: f.exportFixture(), scratch: f.scratch };
  } finally { await mcp.close(); }
}, { sourceRevision: '3339517' });
writeFileSync(evidencePath('migration-service.json'), JSON.stringify(report, null, 2) + '\n');
console.log('PASS migration, retained old MCP/REST transcript, schema refusal, enforcing rollback, key reuse');
