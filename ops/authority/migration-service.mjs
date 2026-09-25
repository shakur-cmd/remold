import assert from 'node:assert/strict';
import { anyApi } from 'convex/server';
import { cpSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '../../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { withAuthority } from './local.mjs';
const report = await withAuthority(async f => {
  const human = f.client('migration-owner'); await human.mutation(anyApi.users.store, {}); const orgId = await human.mutation(anyApi.orgs.create, { name: 'Authority migration synthetic' });
  const legacy = await human.action(anyApi.agents.create, { orgId, name: 'Retained legacy agent', role: 'admin', grants: ['create', 'update', 'delete'].map(action => ({ action, objectKey: '*' })) });
  const objects = await human.query(anyApi.objects.list, { orgId }), company = objects.find(o => o.key === 'company');
  const keys = objects.map(o => o.key).sort(), transcript = [];
  const rest = async (method, path, body) => { const response = await fetch(f.site + '/api/v1/' + path, { method, headers: { authorization: 'Bearer ' + legacy.key, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const data = await response.json(); return { status: response.status, data }; };
  const oldMcp = join(f.scratch, 'old-mcp'); cpSync(join(f.root, 'packages/mcp/dist'), oldMcp, { recursive: true }); writeFileSync(join(oldMcp, 'package.json'), '{"type":"module"}'); symlinkSync(join(f.root, 'packages/mcp/node_modules'), join(oldMcp, 'node_modules'), 'dir');
  const mcp = new Client({ name: 'retained-authority-migration-client', version: '1' });
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [join(oldMcp, 'index.js')], env: { PATH: process.env.PATH, REMOLD_URL: f.site, REMOLD_KEY: legacy.key }, stderr: 'pipe' }));
  const call = async (phase, name, args = {}) => { const response = await mcp.callTool({ name, arguments: args }); assert.ok(!response.isError, JSON.stringify(response)); const data = JSON.parse(response.content[0].text); transcript.push({ phase, name, args, data }); return data; };
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
    assert.equal((await rest('POST', 'changes', { action: 'create', object: 'future', values: { name: 'denied' }, reason: 'scope ceiling' })).status, 403);
    const first = f.run('authority/migration:migrateAgent', { agentId: legacy.agentId }); assert.equal(first.changed, true); assert.equal(f.run('authority/migration:migrateAgent', { agentId: legacy.agentId }).changed, false);
    const after = await exercise('migrated'); assert.deepEqual(after, baseline);
    const migratedSnapshot = f.run('authorityFixture:snapshot', { orgId }); assert.equal(migratedSnapshot.agents[0].keyHash, baselineSnapshot.agents[0].keyHash); assert.equal(migratedSnapshot.agents[0].role, baselineSnapshot.agents[0].role); assert.ok(!migratedSnapshot.agents[0].readObjectIds.includes(futureId));
    const schemaFailure = await f.reload(() => writeFileSync(join(f.scratch, 'convex/schema.ts'), baselineSchema), true);
    await f.reload(() => writeFileSync(join(f.scratch, 'convex/schema.ts'), expandedSchema));
    const rollback = await exercise('compatible-enforcing-rollback'); assert.deepEqual(rollback, baseline);
    assert.equal((await rest('POST', 'changes', { action: 'create', object: 'future', values: { name: 'denied after rollback' }, reason: 'scope ceiling' })).status, 403);
    f.run('authorityFixture:keyReuse', { objectId: company._id, key: 'old-company' });
    await human.mutation(anyApi.objects.create, { orgId, key: 'company', label: 'Replacement company', labelPlural: 'Replacement companies' });
    assert.equal((await rest('POST', 'changes', { action: 'create', object: 'company', values: { name: 'key reuse denied' }, reason: 'identity ceiling' })).status, 403);
    return { status: 'PASS bounded migration and old-client compatibility', level: 'SERVICE local backend / synthetic JWT and data', baselineRevision: '3339517', oldMcpHash: f.sha(readFileSync(join(oldMcp, 'index.js'))), cutoff, baselineSnapshot, migratedSnapshot, transcript, normalizedTranscript: { baseline, fallback, after, rollback }, schemaFailure, fixture: f.exportFixture(), scratch: f.scratch };
  } finally { await mcp.close(); }
}, { sourceRevision: '3339517' });
writeFileSync('ops/authority/evidence/migration-service.json', JSON.stringify(report, null, 2) + '\n');
console.log('PASS migration, retained old MCP/REST transcript, schema refusal, enforcing rollback, key reuse');
