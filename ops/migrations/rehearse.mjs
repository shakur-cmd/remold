import { spawn, execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, cpSync, symlinkSync, writeFileSync, readFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { Client } from '../../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { assertRollbackTarget } from './rollback.mjs';

const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '../..');
const args = process.argv.slice(2), output = resolve(args[0] ?? join(here, 'evidence/latest.json'));
const fixtureCount = Number(args[1] ?? 1000), breakBrowserAuth = args.includes('--break-browser-auth');
assert.ok(Number.isInteger(fixtureCount) && fixtureCount >= 1000 && fixtureCount <= 5000 && fixtureCount % 100 === 0, 'Fixture count must be a multiple of 100 from 1000 to 5000');
const scratch = mkdtempSync(join(tmpdir(), 'remold-migration-'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const rootEnvHash = existsSync(join(root, '.env.local')) ? hash(readFileSync(join(root, '.env.local'))) : null;
const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CI: '1', CONVEX_AGENT_MODE: 'anonymous', CONVEX_DISABLE_METRICS: '1' };
const cli = join(here, 'node_modules/convex/bin/main.js');
const url = 'http://127.0.0.1:3440', site = 'http://127.0.0.1:3441';
const execAsync = promisify(execFile);
const pause = ms => new Promise(r => setTimeout(r, ms));
let logs = '', phase = 'baseline', backend, browser, browserCdp, browserServer, mcp, oldClientLoop, stopClients = false;
const issuer = 'https://remold-rehearsal.invalid', applicationID = 'remold-rehearsal', kid = 'remold-rehearsal-key';
const keypair = generateKeyPairSync('rsa', { modulusLength: 2048 }), publicJwk = { ...keypair.publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
const jwks = JSON.stringify({ keys: [publicJwk] }), jwksDataUri = `data:text/plain;charset=utf-8;base64,${Buffer.from(jwks).toString('base64')}`;
const token = key => { const now = Math.floor(Date.now() / 1000), encode = value => Buffer.from(JSON.stringify(value)).toString('base64url'), input = `${encode({ alg: 'RS256', kid, typ: 'JWT' })}.${encode({ iss: issuer, sub: 'old-browser', aud: applicationID, iat: now, exp: now + 7200 })}`; return `${input}.${sign('RSA-SHA256', Buffer.from(input), key).toString('base64url')}`; };
const browserToken = token(breakBrowserAuth ? generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey : keypair.privateKey);
const observations = [], results = { sourceRootSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sourceRootDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()), result: 'FAIL', level: 'SERVICE-local; synthetic fixture', scratch, checks: {}, limitations: ['Managed backup snapshot restore is not tested', 'Production identities are not tested; old browser is a headless Chromium ConvexClient bundle built from the baseline source, not the full React app', 'No production deployment or release authorization'] };
function treeHash(dir) {
  const entries = [];
  const walk = (part = '') => { for (const entry of readdirSync(join(dir, part), { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
    const name = join(part, entry.name);
    if (entry.isDirectory()) walk(name); else entries.push([name, hash(readFileSync(join(dir, name)))]);
  } };
  walk(); return hash(JSON.stringify(entries));
}
const authConfig = jwksUrl => `export default { providers: [{ type: 'customJwt', issuer: ${JSON.stringify(issuer)}, applicationID: ${JSON.stringify(applicationID)}, algorithm: 'RS256', jwks: ${JSON.stringify(jwksUrl)} }] };\n`;
class Cdp {
  constructor(ws) { this.ws = ws; this.next = 0; this.pending = new Map(); ws.addEventListener('message', event => { const message = JSON.parse(event.data); const pending = this.pending.get(message.id); if (!pending) return; this.pending.delete(message.id); message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result); }); }
  call(method, params = {}) { return new Promise((resolve, reject) => { const id = ++this.next; this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async evaluate(expression) { const result = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; }
  close() { this.ws.close(); }
}
async function openBrowserCdp(port) {
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = pages.find(target => target.type === 'page');
  if (!page?.webSocketDebuggerUrl) throw new Error('Chromium did not expose a page debugger URL');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  return new Cdp(ws);
}
async function browserSnapshot() { return browserCdp.evaluate('window.oldBrowserState && window.oldBrowserState()'); }
async function waitForBrowser(check, timeout = 10_000) {
  const until = Date.now() + timeout;
  while (Date.now() <= until) { if (await check()) return true; if (browser?.exitCode !== null && browser?.exitCode !== undefined) throw new Error('Old browser exited'); await pause(100); }
  return false;
}
async function startBrowserServer() {
  browserServer = createServer((request, response) => {
    const files = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/bundle.js': ['bundle.js', 'application/javascript'], '/jwks': [null, 'application/json'] };
    const file = files[request.url];
    if (!file) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': file[1], 'cache-control': 'no-store' });
    response.end(file[0] ? readFileSync(join(scratch, 'old-browser', file[0])) : jwks);
  });
  await new Promise((resolve, reject) => { browserServer.once('error', reject); browserServer.listen(3442, '127.0.0.1', resolve); });
}
async function launchOldBrowser() {
  const binary = process.env.REMOLD_REHEARSAL_CHROME ?? '/Users/urkel/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell';
  if (!existsSync(binary)) throw new Error(`Old browser binary missing: ${binary}; set REMOLD_REHEARSAL_CHROME to a Chromium headless-shell binary`);
  let browserLogs = '';
  browser = spawn(binary, ['--headless', '--remote-debugging-port=0', `--user-data-dir=${join(scratch, 'old-browser-profile')}`, '--no-first-run', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  browser.stderr.on('data', data => { browserLogs += data; });
  let port;
  await waitForBrowser(() => { const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(browserLogs); if (match) port = Number(match[1]); return Boolean(port); });
  if (!port) throw new Error(`Chromium did not start DevTools: ${browserLogs.slice(-1000)}`);
  browserCdp = await openBrowserCdp(port);
  const version = await browserCdp.call('Browser.getVersion');
  await browserCdp.call('Page.navigate', { url: 'http://127.0.0.1:3442/' });
  const ready = await waitForBrowser(() => browserCdp.evaluate('typeof window.start === "function"').catch(() => false));
  if (!ready) throw new Error('Old browser bundle did not load');
  return { binary, version, browserLogs };
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
  writeFileSync(join(scratch, 'convex/auth.config.ts'), authConfig(jwksDataUri));
  writeFileSync(join(scratch, 'package.json'), JSON.stringify({ name: 'remold-isolated-migration', type: 'module', private: true, dependencies: { convex: '1.46.0', '@convex-dev/rate-limiter': '0.4.0', '@convex-dev/migrations': '0.3.6', 'convex-helpers': '0.1.124' } }));
  mkdirSync(join(scratch, 'node_modules'));
  linkPackages(join(here, 'node_modules')); linkPackages(join(root, 'node_modules'));
  const oldBrowserDir = join(scratch, 'old-browser');
  mkdirSync(oldBrowserDir);
  writeFileSync(join(oldBrowserDir, 'entry.js'), `import { ConvexClient } from 'convex/browser';
import { anyApi } from 'convex/server';
const state = { loadId: crypto.randomUUID(), observed: [], updates: 0, writes: 0, errors: [], reconnects: 0 };
window.oldBrowserState = () => ({ loadId: state.loadId, observed: [...state.observed], updates: state.updates, writes: state.writes, errors: [...state.errors], reconnects: state.reconnects });
window.start = async (url, token, orgId, recordId, titleFieldId) => {
  state.client = new ConvexClient(url); state.orgId = orgId; state.recordId = recordId; state.titleFieldId = titleFieldId;
  state.client.setAuth(async () => token);
  state.unsubscribe = state.client.onUpdate(anyApi.records.get, { orgId, recordId }, value => { state.updates++; state.observed.push({ title: value?.record?.title ?? null, name: value?.record?.values?.[titleFieldId] ?? null }); });
  return window.oldBrowserState();
};
window.write = async name => { try { await state.client.mutation(anyApi.records.update, { orgId: state.orgId, recordId: state.recordId, values: { [state.titleFieldId]: name }, reason: 'old-browser-rehearsal' }); state.writes++; return { ok: true }; } catch (error) { const message = String(error); state.errors.push(message); return { ok: false, error: message }; } };
`);
  writeFileSync(join(oldBrowserDir, 'index.html'), '<!doctype html><script src="/bundle.js"></script>');
  const requireFromConvex = createRequire(createRequire(import.meta.url).resolve('convex', { paths: [join(scratch, 'node_modules')] }));
  await requireFromConvex('esbuild').build({ entryPoints: [join(oldBrowserDir, 'entry.js')], outfile: join(oldBrowserDir, 'bundle.js'), bundle: true, format: 'iife', platform: 'browser' });
  await startBrowserServer();
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
  await run('migrationFixture:bindBrowserUser', { userId: ids.userId, tokenIdentifier: `${issuer}|old-browser` });
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
  results.oldBrowser = { bundleSha256: hash(readFileSync(join(oldBrowserDir, 'bundle.js'))), baselineSourceHash: results.baseline.sourceHash, auth: breakBrowserAuth ? 'different-key negative control' : 'data-uri JWKS' };
  // Keep one pre-expansion stdio process alive through every subsequent deployment.
  cpSync(join(root, 'packages/mcp/dist'), join(scratch, 'old-mcp'), { recursive: true });
  writeFileSync(join(scratch, 'old-mcp/package.json'), '{"type":"module"}');
  symlinkSync(join(root, 'packages/mcp/node_modules'), join(scratch, 'old-mcp/node_modules'), 'dir');
  results.oldMcpSourceHash = hash(readFileSync(join(scratch, 'old-mcp/index.js')));
  mcp = new Client({ name: 'retained-migration-client', version: '1' });
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [join(scratch, 'old-mcp/index.js')], env: { PATH: env.PATH, REMOLD_URL: site, REMOLD_KEY: key }, stderr: 'pipe' }));
  const restRecord = (await rest('POST', '/changes', { action: 'create', object: 'company', values: { name: 'Retained REST record' }, reason: 'synthetic-rehearsal' }, key)).record;
  const mcpRecord = (await tool('remold_apply_change', { action: 'create', object: 'company', values: { name: 'Retained MCP record' }, reason: 'synthetic-rehearsal' })).record;
  const browserRecord = (await rest('POST', '/changes', { action: 'create', object: 'company', values: { name: 'Retained browser record' }, reason: 'synthetic-rehearsal' }, key)).record;
  const browserInfo = await launchOldBrowser();
  results.oldBrowser.binary = browserInfo.version;
  await browserCdp.evaluate(`window.start(${JSON.stringify(url)}, ${JSON.stringify(browserToken)}, ${JSON.stringify(ids.orgId)}, ${JSON.stringify(browserRecord.id)}, ${JSON.stringify(ids.titleFieldId)})`);
  let browserStarted = await waitForBrowser(async () => (await browserSnapshot())?.observed.some(value => value.name === 'Retained browser record'));
  if (!browserStarted && !breakBrowserAuth) {
    await deploy(() => writeFileSync(join(scratch, 'convex/auth.config.ts'), authConfig('http://127.0.0.1:3442/jwks')));
    results.oldBrowser.auth = 'loopback JWKS fallback';
    results.oldBrowser.jwksDeviation = 'Convex local backend did not accept the data: JWKS URI; switched the scratch-only provider to http://127.0.0.1:3442/jwks without reloading Chromium';
    browserStarted = await waitForBrowser(async () => (await browserSnapshot())?.observed.some(value => value.name === 'Retained browser record'));
  }
  if (!breakBrowserAuth) assert.ok(browserStarted, 'Old browser subscription did not authenticate before expansion');
  const browserLoadId = (await browserSnapshot()).loadId;
  results.oldBrowser.loadId = browserLoadId;
  let browserLastWrite;
  oldClientLoop = (async () => {
    for (let iteration = 0; !stopClients; iteration++) {
      const observedPhase = phase;
      const progress = observedPhase === 'resumed-migration' ? (await run('migrationBackfill:status'))[0] : undefined;
      await rest('POST', '/changes', { action: 'update', record: restRecord.id, values: { name: `Retained REST ${iteration}` }, reason: 'synthetic-rehearsal' }, key);
      await tool('remold_apply_change', { action: 'update', record: mcpRecord.id, values: { name: `Retained MCP ${iteration}` }, reason: 'synthetic-rehearsal' });
      browserLastWrite = `Retained browser ${iteration}`;
      const browserWrite = await browserCdp.evaluate(`window.write(${JSON.stringify(browserLastWrite)})`);
      assert.ok(browserWrite?.ok, `Old browser write failed: ${browserWrite?.error}`);
      assert.ok(await waitForBrowser(async () => (await browserSnapshot())?.observed.some(value => value.name === browserLastWrite)), `Old browser subscription missed ${browserLastWrite}`);
      assert.equal((await browserSnapshot()).loadId, browserLoadId, 'Old browser page reloaded');
      const restRead = await rest('GET', `/records/${restRecord.id}`, null, key);
      const mcpRead = await tool('remold_get_record', { idOrRef: mcpRecord.id });
      assert.equal(restRead.record.values.name, `Retained REST ${iteration}`);
      assert.equal(mcpRead.record.values.name, `Retained MCP ${iteration}`);
      observations.push({ phase: observedPhase, iteration, ...(progress ? { migrationState: progress.state, processedBeforeWrite: progress.processed } : {}), rest: 'read/write pass', mcp: 'read/write pass', browser: 'subscription/write pass' });
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
  await waitFor(() => observations.filter(o => o.phase === 'rollback' && o.browser === 'subscription/write pass').length >= 2 || clientFailure, 'old clients after partial rollback');
  if (clientFailure) throw clientFailure;
  results.checks.rollbackWhilePartiallyMigrated = true;
  phase = 'resumed-migration';
  await run('migrationFixture:allowResume', { orgId: ids.orgId });
  await run('migrationBackfill:markRecords', { batchSize: 1 });
  let finished;
  await waitFor(async () => { finished = (await run('migrationBackfill:status'))[0]; return finished?.state === 'success'; }, 'resume completion');
  assert.equal(finished.processed, fixtureCount + 4);
  const migrated = await run('migrationFixture:snapshot');
  assert.equal(migrated.records.filter(r => r.migrationRevision === 1).length, fixtureCount + 4);
  await run('migrationBackfill:markRecords', {});
  assert.deepEqual((await run('migrationBackfill:status'))[0], finished);
  results.resumed = finished;
  results.checks.idempotentRepeat = true;
  assert.ok(observations.some(o => o.migrationState === 'inProgress' && o.processedBeforeWrite >= 400 && o.browser === 'subscription/write pass'), 'Old clients must read and write while the real component is in progress');
  assert.equal((await rest('GET', '/me', null, key)).agent.id, ids.agentId);
  const final = await run('migrationFixture:snapshot');
  writeFileSync(join(scratch, 'final-snapshot.json'), JSON.stringify(final, null, 2));
  results.final = { canonicalHash: hash(JSON.stringify(final)), records: final.records.length, migration: finished };
  assert.equal(final.records.length, fixtureCount + 4);
  assert.equal(final.records.filter(r => r.migrationRevision === 1).length, fixtureCount + 4);
  assert.deepEqual(final.agents, baseline.agents);
  assert.deepEqual(final.records.filter(r => r.title.startsWith('Migration fixture ')).map(({ migrationRevision, ...record }) => record), baseline.records);
  results.checks.originalFixtureRecordsPreserved = true;
  assert.equal((await rest('GET', `/records/${midMigrationRecord.id}`, null, key)).record.values.name, 'Created during partial backfill');
  results.checks.recordCreatedMidMigrationRetained = true;
  results.checks.recordsAndKeyRetained = true;
  stopClients = true; await oldClientLoop;
  assert.equal((await rest('GET', `/records/${browserRecord.id}`, null, key)).record.values.name, browserLastWrite);
  const browserFinal = await browserSnapshot();
  assert.equal(browserFinal.loadId, browserLoadId, 'Old browser page reloaded before final read');
  results.oldBrowser = { ...results.oldBrowser, loadIdUnchanged: true, subscriptionUpdates: browserFinal.updates, writes: browserFinal.writes, ...(browserFinal.reconnects ? { reconnects: browserFinal.reconnects } : {}) };
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
  browserCdp?.close();
  browser?.kill('SIGTERM');
  await new Promise(resolve => browserServer ? browserServer.close(resolve) : resolve());
  if (backend) { try { process.kill(-backend.pid, 'SIGTERM'); } catch {} }
  writeFileSync(join(scratch, 'backend.log'), logs);
  results.rootDeploymentConfigUnchanged = rootEnvHash === (existsSync(join(root, '.env.local')) ? hash(readFileSync(join(root, '.env.local'))) : null);
  writeFileSync(output, JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify({ result: results.result, output, scratch }));
}
