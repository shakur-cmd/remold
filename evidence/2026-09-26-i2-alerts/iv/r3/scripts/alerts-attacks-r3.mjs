// Independent verifier service attacks on the I2 alert slice (a173192).
// Disposable anonymous local Convex on loopback, synthetic data, local sinks only.
// Phases: scrub (errors/args/URLs/query strings/function names), concurrent checks,
// redirect past the loopback rule, coverage cap driven by real REST traffic, and
// large scheduled arguments against the mutation read limit.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withLocalCore } from '../../../../../ops/rehearsal/local-core.mjs';

const CLOUD = 3972, SITE = 3973, SINK = 3974, SINK6 = 3975;
const out = process.argv.find(a => a.startsWith('--out='))?.slice(6) ?? '/tmp/iv-alerts/attacks.json';
const pause = ms => new Promise(r => setTimeout(r, ms));
const EMAIL = 'iv.private.person@example.invalid', SECRET = 'sk_live_iv_synthetic_0123456789abcdef', RECORD = 'iv-record-text-must-not-leave';
const FORBIDDEN = [EMAIL, SECRET, RECORD, 'example.invalid', 'sk_live', 'evil.invalid', 'Synthetic', 'iv-secret-path', 'token='];

const received = [], received6 = [];
const mk = (list, redirect) => createServer((req, res) => {
  let body = ''; req.on('data', c => { body += c; });
  req.on('end', () => {
    list.push({ at: Date.now(), method: req.method, path: req.url, headers: req.headers, body });
    if (redirect && req.url.startsWith('/redirect')) return res.writeHead(307, { location: `http://[::1]:${SINK6}/landed` }).end();
    res.writeHead(204).end();
  });
});
const sink = mk(received, true), sink6 = mk(received6, false);
await new Promise(r => sink.listen(SINK, '127.0.0.1', r));
await new Promise(r => sink6.listen(SINK6, '::1', r));

const fixture = `declare const process: { env: Record<string, string | undefined> };
import { internalMutation, internalQuery } from "./_generated/server";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
const failRef = makeFunctionReference<"mutation">("ivFixture:fail");
const noopRef = makeFunctionReference<"mutation">("ivFixture:noop");
export const fail = internalMutation({ args: { note: v.string(), url: v.string() }, handler: async (_ctx, { note, url }) => { throw new Error("Synthetic failure for " + note + " at " + url); } });
export const failTwo = internalMutation({ args: {}, handler: async () => { throw new Error("Synthetic second failure"); } });
export const kickFailTwo = internalMutation({ args: {}, handler: async (ctx) => { await ctx.scheduler.runAfter(0, makeFunctionReference<"mutation">("ivFixture:failTwo"), {}); } });
export const noop = internalMutation({ args: { pad: v.string() }, handler: async () => {} });
export const kickFail = internalMutation({ args: { note: v.string(), url: v.string() }, handler: async (ctx, args) => { await ctx.scheduler.runAfter(0, failRef, args); } });
export const kickMany = internalMutation({ args: { n: v.number(), size: v.number() }, handler: async (ctx, { n, size }) => { const pad = "x".repeat(size); for (let i = 0; i < n; i++) await ctx.scheduler.runAfter(0, noopRef, { pad }); } });
export const kickBogus = internalMutation({ args: {}, handler: async (ctx) => { try { await ctx.scheduler.runAfter(0, makeFunctionReference<"mutation">("ivFixture:${EMAIL.replace(/[@.]/g, '_')}"), {}); return "scheduled"; } catch (e) { return "refused: " + String(e).slice(0, 200); } } });
export const tables = internalQuery({ args: {}, handler: async (ctx) => ({ alerts: await ctx.db.query("opsAlerts").collect(), notices: await ctx.db.query("opsNotices").collect() }) });
export const counts = internalQuery({ args: {}, handler: async (ctx) => { const rows = await ctx.db.system.query("_scheduled_functions").order("desc").take(4000); return { rowsSeenCapped4000: rows.length, byName: rows.reduce((m: any, r) => { m[r.name] = (m[r.name] ?? 0) + 1; return m; }, {}) }; } });
`;

const result = await withLocalCore(async ({ site, run, scratch, root }) => {
  const cli = join(root, 'node_modules/convex/bin/main.js');
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CONVEX_AGENT_MODE: 'anonymous', CI: '1', CONVEX_DISABLE_METRICS: '1' };
  const setting = (k, v) => execFileSync(process.execPath, [cli, 'env', 'set', k, v], { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  const unset = k => execFileSync(process.execPath, [cli, 'env', 'remove', k], { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  const check = async () => { try { return JSON.parse((await promisify(execFile)(process.execPath, [cli, 'run', 'alerts:check', '{}'], { cwd: scratch, env, timeout: 90_000 })).stdout); } catch (e) { return { error: String(e.stderr ?? e).split('\n').filter(l => /Error|error|limit|bytes/i.test(l)).slice(0, 4).join(' | ').slice(0, 600) }; } };
  const waitFor = async (fn, label, timeout = 60_000) => { const end = Date.now() + timeout; let v; while (!(v = await fn())) { assert.ok(Date.now() < end, 'Timeout: ' + label); await pause(300); } return v; };
  const httpPath = join(scratch, 'convex/http.ts');
  writeFileSync(httpPath, readFileSync(httpPath, 'utf8').replace('async function dispatch(ctx: any, request: Request) {', `async function dispatch(ctx: any, request: Request) {
  if (new URL(request.url).pathname.startsWith("/api/v1/iv-fixture")) throw new Error("Synthetic REST failure " + request.url + " " + (request.headers.get("authorization") ?? ""));`));
  writeFileSync(join(scratch, 'convex/ivFixture.ts'), fixture);
  await waitFor(() => { try { return run('ivFixture:counts') !== null; } catch { return false; } }, 'fixture deployed', 90_000);
  const phases = {};
  const allRaw = () => [...received, ...received6].map(r => r.body + JSON.stringify(r.headers) + r.path).join('\n');
  const leaks = text => FORBIDDEN.filter(f => text.includes(f));

  // Phase 1: scrub. Error text, args, REST path id and query string, auth header, function name.
  setting('REMOLD_ALERT_WEBHOOK_URL', `http://127.0.0.1:${SINK}/hook`);
  setting('REMOLD_ALERT_WINDOW_MINUTES', '1');
  run('ivFixture:kickFail', { note: `${EMAIL} ${SECRET} ${RECORD}`, url: `https://evil.invalid/iv-secret-path?token=${SECRET}` });
  const bogus = run('ivFixture:kickBogus');
  const restStatus = (await fetch(`${site}/api/v1/iv-fixture/rec_${RECORD}?email=${encodeURIComponent(EMAIL)}&token=${SECRET}`, { headers: { authorization: `Bearer ${SECRET}` } })).status;
  await pause(3000);
  const c1 = await check();
  const t1 = run('ivFixture:tables');
  phases.scrub = { bogusFunctionName: bogus, restStatus, check: c1, sinkBodies: received.map(r => JSON.parse(r.body)), storedAlerts: t1.alerts.map(({ key, kind, fn, count, state }) => ({ key, kind, fn, count, state })), leaksInSink: leaks(allRaw()), leaksInStoredTables: leaks(JSON.stringify(t1)) };

  // Phase 2: six concurrent manual checks while a new fault opens; cron may also run.
  run('ivFixture:kickFailTwo'); // a fresh key, so six concurrent checks race to open it
  await pause(1500);
  const before = received.length;
  const concurrent = await Promise.all(Array.from({ length: 6 }, () => check()));
  await pause(2000);
  const t2 = run('ivFixture:tables');
  const keys = t2.alerts.map(a => a.key);
  phases.concurrent = { results: concurrent, newDeliveries: received.slice(before).map(r => JSON.parse(r.body)), alertRowsPerKey: Object.fromEntries([...new Set(keys)].map(k => [k, keys.filter(x => x === k).length])), deliveredIds: received.map(r => JSON.parse(r.body).id) };
  phases.concurrent.duplicateIds = phases.concurrent.deliveredIds.filter((id, i, a) => a.indexOf(id) !== i);

  // Phase 3: direct [::1] and 0.0.0.0 are refused; a 307 from the loopback sink to [::1] is followed.
  const channelFor = async url => { setting('REMOLD_ALERT_WEBHOOK_URL', url); await pause(500); return run('alerts:status').channel; };
  phases.redirect = { directIpv6: await channelFor(`http://[::1]:${SINK6}/direct`), direct0000: await channelFor(`http://0.0.0.0:${SINK6}/direct`) };
  setting('REMOLD_ALERT_WEBHOOK_URL', `http://127.0.0.1:${SINK}/redirect`);
  // Force a fresh notice: the REST window (1 minute) passes and rest-500 resolves.
  await waitFor(async () => { await check(); return received6.length > 0 || received.some(r => r.path.startsWith('/redirect')); }, 'redirect attempt', 200_000);
  await pause(1000);
  phases.redirect.received6 = received6.map(r => ({ method: r.method, path: r.path, body: r.body }));
  phases.redirect.redirectHits = received.filter(r => r.path.startsWith('/redirect')).length;
  setting('REMOLD_ALERT_WEBHOOK_URL', `http://127.0.0.1:${SINK}/hook`);

  // Phase 4: coverage cap driven by ordinary REST traffic (each request schedules telemetry:record).
  const t0 = Date.now();
  let sent = 0;
  await Promise.all(Array.from({ length: 50 }, async () => { while (sent < 5100) { sent++; await fetch(`${site}/api/v1/me`).catch(() => {}); } }));
  const restMs = Date.now() - t0;
  await pause(5000);
  const c4 = await check();
  phases.coverage = { restRequests: sent, restMs, scheduledRows: run('ivFixture:counts'), check: c4, status: run('alerts:status') };

  // Phase 5: large scheduled arguments vs the mutation read limit (latent; no current caller does this).
  for (let i = 0; i < 20; i++) run('ivFixture:kickMany', { n: 250, size: 4000 });
  await pause(8000);
  phases.largeArgs = { scheduledRows: run('ivFixture:counts').rowsSeenCapped4000, check: await check(), status: run('alerts:status') };

  unset('REMOLD_ALERT_WEBHOOK_URL');
  return { level: 'SERVICE disposable local Convex, synthetic data, local sinks', phases, allSinkLeaks: leaks(allRaw()) };
}, { cloudPort: CLOUD, sitePort: SITE }).finally(() => { sink.close(); sink6.close(); });

writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ out, leaks: result.allSinkLeaks, dup: result.phases.concurrent.duplicateIds, redirect: result.phases.redirect, coverage: result.phases.coverage.check, largeArgs: result.phases.largeArgs.check }));
