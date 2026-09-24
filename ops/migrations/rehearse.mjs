import { spawn, execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, cpSync, symlinkSync, writeFileSync, readFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { Client } from '../../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { assertRollbackTarget } from './rollback.mjs';

const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '../..');
const output = resolve(process.argv[2] ?? join(here, 'evidence/latest.json'));
const fixtureCount = Number(process.argv[3] ?? 1000);
assert.ok(Number.isInteger(fixtureCount) && fixtureCount >= 1000 && fixtureCount <= 5000 && fixtureCount % 100 === 0, 'Fixture count must be a multiple of 100 from 1000 to 5000');
const scratch = mkdtempSync(join(tmpdir(), 'remold-migration-'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const rootEnvHash = existsSync(join(root, '.env.local')) ? hash(readFileSync(join(root, '.env.local'))) : null;
const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CI: '1', CONVEX_AGENT_MODE: 'anonymous', CONVEX_DISABLE_METRICS: '1' };
const cli = join(here, 'node_modules/convex/bin/main.js');
const url = 'http://127.0.0.1:3440', site = 'http://127.0.0.1:3441';
const execAsync = promisify(execFile);
const pause = ms => new Promise(r => setTimeout(r, ms));
let logs = '', phase = 'baseline', backend, mcp, oldClientLoop, stopClients = false;
const observations = [], results = { sourceRootSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sourceRootDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()), result: 'FAIL', level: 'SERVICE-local; synthetic fixture', scratch, checks: {}, limitations: ['Managed backup snapshot restore is not tested', 'Actual old browser and production identities are not tested', 'No production deployment or release authorization'] };
function treeHash(dir) {
  const entries = [];
  const walk = (part = '') => { for (const entry of readdirSync(join(dir, part), { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
    const name = join(part, entry.name);
    if (entry.isDirectory()) walk(name); else entries.push([name, hash(readFileSync(join(dir, name)))]);
  } };
  walk(); return hash(JSON.stringify(entries));
}
async function waitFor(check, label, timeout = 120_000) {
  const until = Date.now() + timeout;
  while (!await check()) {
    if (backend?.exitCode !== null && backend?.exitCode !== undefined) throw new Error(`Backend exited: ${label}`);
    if (Date.now() > until) throw new Error(`Timed out: ${label}; inspect private scratch backend.log`);
    await pause(200);
  }
}
async function run(fn, args = {}) {
  const { stdout } = await execAsync(process.execPath, [cli, 'run', fn, JSON.stringify(args)], { cwd: scratch, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 8_000_000 });
  return stdout.trim() ? JSON.parse(stdout) : null;
}
async function deploy(edit) {
  const offset = logs.length;
  edit();
  await waitFor(() => /Convex functions ready/.test(logs.slice(offset)), `deploy ${phase}`);
}
function linkPackages(from) {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (entry.name.startsWith('@')) {
      mkdirSync(join(scratch, 'node_modules', entry.name), { recursive: true });
      for (const name of readdirSync(join(from, entry.name))) {
        const target = join(scratch, 'node_modules', entry.name, name);
        if (!existsSync(target)) symlinkSync(join(from, entry.name, name), target, 'dir');
      }
    } else {
      const target = join(scratch, 'node_modules', entry.name);
      if (!existsSync(target)) symlinkSync(join(from, entry.name), target, 'dir');
    }
  }
}
async function rest(method, path, body, key) {
  const response = await fetch(`${site}/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000) });
  const data = await response.json();
  assert.ok(response.ok, JSON.stringify(data)); return data;
}
async function tool(name, args) {
  const response = await mcp.callTool({ name, arguments: args });
  assert.ok(!response.isError, JSON.stringify(response));
  return JSON.parse(response.content[0].text);
}
try {
  cpSync(join(root, 'convex'), join(scratch, 'convex'), { recursive: true, filter: p => !p.endsWith('.test.ts') && !p.endsWith('test.helpers.ts') && !p.endsWith('test.setup.ts') });
  cpSync(join(here, 'fixture.ts'), join(scratch, 'convex/migrationFixture.ts'));
  writeFileSync(join(scratch, 'convex/auth.config.ts'), 'export default { providers: [] };\n');
  writeFileSync(join(scratch, 'package.json'), JSON.stringify({ name: 'remold-isolated-migration', type: 'module', private: true, dependencies: { convex: '1.46.0', '@convex-dev/rate-limiter': '0.4.0', '@convex-dev/migrations': '0.3.6', 'convex-helpers': '0.1.124' } }));
  mkdirSync(join(scratch, 'node_modules'));
  linkPackages(join(here, 'node_modules')); linkPackages(join(root, 'node_modules'));
  const schemaPath = join(scratch, 'convex/schema.ts');
  const baselineSchema = readFileSync(schemaPath, 'utf8');
  const expandedSchema = baselineSchema.replace('records: defineTable({ orgId:', 'records: defineTable({ migrationRevision: v.optional(v.number()), orgId:');
  assert.notEqual(expandedSchema, baselineSchema);
  const versionPath = join(scratch, 'convex/migrationVersion.ts');
  const versionSource = name => `import { internalQuery } from './_generated/server';
import { v } from 'convex/values';
export const current = internalQuery({args:{},handler:()=> '${name}'});
export const read = internalQuery({args:{recordId:v.id('records')},handler:async(ctx,{recordId})=>{
  const record = await ctx.db.get(recordId);
  if(!record) throw new Error('Missing synthetic record');
  return {title:record.title,effectiveRevision:${name === 'migrate' ? 'record.migrationRevision ?? 0' : '0'}};
}});
`;
  writeFileSync(versionPath, versionSource('baseline'));
  backend = spawn(process.execPath, [cli, 'dev', '--typecheck', 'disable', '--tail-logs', 'disable', '--local-cloud-port', '3440', '--local-site-port', '3441'], { cwd: scratch, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  backend.stdout.on('data', b => { logs += b; }); backend.stderr.on('data', b => { logs += b; });
  await waitFor(() => /Convex functions ready/.test(logs), 'initial deployment', 180_000);
  const configured = /^CONVEX_URL=(.+)$/m.exec(readFileSync(join(scratch, '.env.local'), 'utf8'))?.[1];
  assert.equal(configured, url, 'Refuse any deployment except the reserved loopback backend');
  const key = `rm_${randomBytes(20).toString('hex')}`;
  const ids = await run('migrationFixture:seed', { keyHash: hash(key) });
  for (let start = 0; start < fixtureCount; start += 100) {
    const { orgId, userId, objectId, titleFieldId } = ids;
    await run('migrationFixture:seedBatch', { orgId, userId, objectId, titleFieldId, start, count: 100 });
  }
  const baseline = await run('migrationFixture:snapshot');
  writeFileSync(join(scratch, 'baseline-snapshot.json'), JSON.stringify(baseline, null, 2));
  assert.equal(baseline.records.length, fixtureCount);
  assert.ok(baseline.records.every(r => r.migrationRevision === undefined));
  const baselineDir = join(scratch, 'baseline-source');
  cpSync(join(scratch, 'convex'), baselineDir, { recursive: true });
  results.baseline = { sourceHash: treeHash(baselineDir), records: fixtureCount, canonicalHash: hash(JSON.stringify(baseline)), schemaHash: hash(baselineSchema) };
  // Keep one pre-expansion stdio process alive through every subsequent deployment.
  cpSync(join(root, 'packages/mcp/dist'), join(scratch, 'old-mcp'), { recursive: true });
  writeFileSync(join(scratch, 'old-mcp/package.json'), '{"type":"module"}');
  symlinkSync(join(root, 'packages/mcp/node_modules'), join(scratch, 'old-mcp/node_modules'), 'dir');
  results.oldMcpSourceHash = hash(readFileSync(join(scratch, 'old-mcp/index.js')));
  mcp = new Client({ name: 'retained-migration-client', version: '1' });
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [join(scratch, 'old-mcp/index.js')], env: { PATH: env.PATH, REMOLD_URL: site, REMOLD_KEY: key }, stderr: 'pipe' }));
  const restRecord = (await rest('POST', '/changes', { action: 'create', object: 'company', values: { name: 'Retained REST record' }, reason: 'synthetic-rehearsal' }, key)).record;
  const mcpRecord = (await tool('remold_apply_change', { action: 'create', object: 'company', values: { name: 'Retained MCP record' }, reason: 'synthetic-rehearsal' })).record;
  oldClientLoop = (async () => {
    for (let iteration = 0; !stopClients; iteration++) {
      const observedPhase = phase;
      const progress = observedPhase === 'resumed-migration' ? (await run('migrationBackfill:status'))[0] : undefined;
      await rest('POST', '/changes', { action: 'update', record: restRecord.id, values: { name: `Retained REST ${iteration}` }, reason: 'synthetic-rehearsal' }, key);
      await tool('remold_apply_change', { action: 'update', record: mcpRecord.id, values: { name: `Retained MCP ${iteration}` }, reason: 'synthetic-rehearsal' });
      const restRead = await rest('GET', `/records/${restRecord.id}`, null, key);
      const mcpRead = await tool('remold_get_record', { idOrRef: mcpRecord.id });
      assert.equal(restRead.record.values.name, `Retained REST ${iteration}`);
      assert.equal(mcpRead.record.values.name, `Retained MCP ${iteration}`);
      observations.push({ phase: observedPhase, iteration, ...(progress ? { migrationState: progress.state, processedBeforeWrite: progress.processed } : {}), rest: 'read/write pass', mcp: 'read/write pass' });
      await pause(1200);
    }
  })();
  // Observe a rejection immediately rather than losing an unhandled background failure.
  let clientFailure;
  oldClientLoop.catch(error => { clientFailure = error; });
  await waitFor(() => observations.length > 0 || clientFailure, 'baseline client writes');
  if (clientFailure) throw clientFailure;
  phase = 'expand';
  await deploy(() => {
    writeFileSync(schemaPath, expandedSchema);
    const configPath = join(scratch, 'convex/convex.config.ts');
    writeFileSync(configPath, readFileSync(configPath, 'utf8').replace('const app = defineApp();', 'import migrations from "@convex-dev/migrations/convex.config.js";\nconst app = defineApp();\napp.use(migrations);'));
    cpSync(join(here, 'backfill.ts'), join(scratch, 'convex/migrationBackfill.ts'));
    writeFileSync(versionPath, versionSource('expand'));
  });
  const expandDir = join(scratch, 'expand-source');
  cpSync(join(scratch, 'convex'), expandDir, { recursive: true });
  const expandSourceHash = treeHash(expandDir);
  results.expand = { sourceHash: expandSourceHash, schemaHash: hash(expandedSchema) };
  phase = 'interrupted-migration';
  await run('migrationBackfill:markRecords', {});
  let interrupted;
  await waitFor(async () => { interrupted = (await run('migrationBackfill:status'))[0]; return interrupted?.state === 'failed'; }, 'deterministic interruption');
  assert.match(interrupted.error, /REHEARSAL_INTERRUPTED_400/);
  const partial = await run('migrationFixture:snapshot');
  writeFileSync(join(scratch, 'interrupted-snapshot.json'), JSON.stringify({ data: partial, migration: interrupted }, null, 2));
  const partialCount = partial.records.filter(r => r.migrationRevision === 1).length;
  assert.ok(partialCount >= 100 && partialCount < fixtureCount);
  results.interruption = { ...interrupted, markedRecords: partialCount, canonicalHash: hash(JSON.stringify(partial)) };
  assert.equal((await run('migrationBackfill:status'))[0].cursor, interrupted.cursor);
  const migratedRecordId = baseline.records[0]._id, pendingRecordId = baseline.records[900]._id;
  results.behavior = { expand: await run('migrationVersion:read', { recordId: migratedRecordId }) };
  assert.equal(results.behavior.expand.effectiveRevision, 0);
  phase = 'migrate';
  await deploy(() => writeFileSync(versionPath, versionSource('migrate')));
  assert.equal(await run('migrationVersion:current'), 'migrate');
  results.behavior.migrate = await run('migrationVersion:read', { recordId: migratedRecordId });
  results.behavior.pending = await run('migrationVersion:read', { recordId: pendingRecordId });
  assert.equal(results.behavior.migrate.effectiveRevision, 1);
  assert.equal(results.behavior.pending.effectiveRevision, 0);
  results.migrate = { sourceHash: treeHash(join(scratch, 'convex')), schemaHash: hash(readFileSync(schemaPath)) };
  const midMigrationRecord = (await rest('POST', '/changes', { action: 'create', object: 'company', values: { name: 'Created during partial backfill' }, reason: 'synthetic-rehearsal' }, key)).record;
  phase = 'rollback';
  assert.throws(() => assertRollbackTarget(expandSourceHash, treeHash(baselineDir), hash(expandedSchema), hash(readFileSync(join(baselineDir, 'schema.ts')))), /declared/);
  results.checks.wrapperRefusedEarlierTarget = true;
  assertRollbackTarget(expandSourceHash, treeHash(expandDir), hash(expandedSchema), hash(readFileSync(join(expandDir, 'schema.ts'))));
  await deploy(() => cpSync(expandDir, join(scratch, 'convex'), { recursive: true }));
  assert.equal(treeHash(join(scratch, 'convex')), expandSourceHash);
  assert.equal(await run('migrationVersion:current'), 'expand');
  results.behavior.rollback = await run('migrationVersion:read', { recordId: migratedRecordId });
  assert.equal(results.behavior.rollback.effectiveRevision, 0);
  assert.equal((await run('migrationFixture:snapshot')).records.find(r => r._id === migratedRecordId).migrationRevision, 1);
  assert.equal((await run('migrationBackfill:status'))[0].cursor, interrupted.cursor);
  await waitFor(() => observations.filter(o => o.phase === 'rollback').length >= 2 || clientFailure, 'old clients after partial rollback');
  if (clientFailure) throw clientFailure;
  results.checks.rollbackWhilePartiallyMigrated = true;
  phase = 'resumed-migration';
  await run('migrationFixture:allowResume', { orgId: ids.orgId });
  await run('migrationBackfill:markRecords', { batchSize: 1 });
  let finished;
  await waitFor(async () => { finished = (await run('migrationBackfill:status'))[0]; return finished?.state === 'success'; }, 'resume completion');
  assert.equal(finished.processed, fixtureCount + 3);
  const migrated = await run('migrationFixture:snapshot');
  assert.equal(migrated.records.filter(r => r.migrationRevision === 1).length, fixtureCount + 3);
  await run('migrationBackfill:markRecords', {});
  assert.deepEqual((await run('migrationBackfill:status'))[0], finished);
  results.resumed = finished;
  results.checks.idempotentRepeat = true;
  assert.ok(observations.some(o => o.migrationState === 'inProgress' && o.processedBeforeWrite >= 400), 'Old clients must read and write while the real component is in progress');
  assert.equal((await rest('GET', '/me', null, key)).agent.id, ids.agentId);
  const final = await run('migrationFixture:snapshot');
  writeFileSync(join(scratch, 'final-snapshot.json'), JSON.stringify(final, null, 2));
  results.final = { canonicalHash: hash(JSON.stringify(final)), records: final.records.length, migration: finished };
  assert.equal(final.records.length, fixtureCount + 3);
  assert.equal(final.records.filter(r => r.migrationRevision === 1).length, fixtureCount + 3);
  assert.deepEqual(final.agents, baseline.agents);
  assert.deepEqual(final.records.filter(r => r.title.startsWith('Migration fixture ')).map(({ migrationRevision, ...record }) => record), baseline.records);
  results.checks.originalFixtureRecordsPreserved = true;
  assert.equal((await rest('GET', `/records/${midMigrationRecord.id}`, null, key)).record.values.name, 'Created during partial backfill');
  results.checks.recordCreatedMidMigrationRetained = true;
  results.checks.recordsAndKeyRetained = true;
  stopClients = true; await oldClientLoop;
  phase = 'negative-schema-probe';
  const beforeNegative = await run('migrationFixture:snapshot');
  const offset = logs.length;
  writeFileSync(schemaPath, baselineSchema);
  await waitFor(() => /schema validation failed|extra field|does not match the schema|SchemaValidationError/i.test(logs.slice(offset)), 'incompatible schema refusal');
  const errorText = logs.slice(offset);
  results.negativeSchema = { refused: true, diagnostic: errorText.replace(/\u001b\[[0-9;]*m/g, '').slice(-3500) };
  assert.deepEqual(await run('migrationFixture:snapshot'), beforeNegative);
  await deploy(() => writeFileSync(schemaPath, expandedSchema));
  results.checks.actualBackendRejectedOldSchemaWithoutDataLoss = true;
  results.clientObservations = observations;
  results.fixtureSourceHashes = Object.fromEntries(['fixture.ts', 'backfill.ts', 'rehearse.mjs', 'rollback.mjs'].map(name => [name, hash(readFileSync(join(here, name)))]));
  results.result = 'PASS';
} catch (error) {
  results.error = error.message;
  throw error;
} finally {
  stopClients = true;
  await oldClientLoop?.catch(() => {});
  await mcp?.close().catch(() => {});
  if (backend) { try { process.kill(-backend.pid, 'SIGTERM'); } catch {} }
  writeFileSync(join(scratch, 'backend.log'), logs);
  results.rootDeploymentConfigUnchanged = rootEnvHash === (existsSync(join(root, '.env.local')) ? hash(readFileSync(join(root, '.env.local'))) : null);
  writeFileSync(output, JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify({ result: results.result, output, scratch }));
}
