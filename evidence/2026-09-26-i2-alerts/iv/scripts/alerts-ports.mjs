// Local alert rehearsal: inject a background failure, a caught REST 500 and a
// stalled scheduled action into a disposable loopback Convex, deliver alerts to
// a local HTTP sink, then recover. `--baseline` runs the same faults without
// configuring or invoking any alert code, to record what happens without it.
// SERVICE level only: the owner-selected production channel is not exercised.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withLocalCore } from '../../../../ops/rehearsal/local-core.mjs';

const baseline = process.argv.includes('--baseline');
const out = process.argv.find(a => a.startsWith('--out='))?.slice(6) ?? new URL(baseline ? './evidence/alerts-baseline.json' : './evidence/alerts-service.json', import.meta.url).pathname;
const pause = ms => new Promise(r => setTimeout(r, ms));
const SINK_PORT = Number(process.env.IV_SINK_PORT ?? 3912);
// Customer-shaped and secret-shaped markers travel in scheduled args, URL and
// headers; the fixture error texts are also forbidden so error forwarding shows.
const EMAIL = 'private.person@example.invalid', SECRET = 'sk_live_synthetic_must_not_leave_0123456789';
const NOTE = `${EMAIL} ${SECRET} record contents must-not-persist`;
const FORBIDDEN = [EMAIL, SECRET, 'must-not-persist', 'Synthetic background failure', 'Synthetic REST failure', 'private=', 'Bearer', 'example.invalid'];

const received = [];
const sink = createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => { received.push({ at: Date.now(), path: req.url, headers: req.headers, body }); res.writeHead(204).end(); });
});
await new Promise(r => sink.listen(SINK_PORT, '127.0.0.1', r));

const fixture = `declare const process: { env: Record<string, string | undefined> };
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
// Scratch-only fixture copied by ops/telemetry/alerts.mjs.
const jobRef = makeFunctionReference<"mutation">("alertFixture:job");
const slowRef = makeFunctionReference<"action">("alertFixture:slow");
export const job = internalMutation({ args: { note: v.string() }, handler: async () => { if (process.env.ALERT_FIXTURE_FAIL === "1") throw new Error("Synthetic background failure"); } });
export const kick = internalMutation({ args: { note: v.string() }, handler: async (ctx, { note }) => { await ctx.scheduler.runAfter(0, jobRef, { note }); } });
export const slow = internalAction({ args: { note: v.string(), ms: v.number() }, handler: async (_ctx, { ms }) => { await new Promise((r) => setTimeout(r, ms)); } });
export const kickSlow = internalMutation({ args: { note: v.string(), ms: v.number() }, handler: async (ctx, args) => { await ctx.scheduler.runAfter(0, slowRef, args); } });
export const scheduled = internalQuery({ args: {}, handler: async (ctx) => (await ctx.db.system.query("_scheduled_functions").order("desc").take(200)).filter((r) => r.name.startsWith("alertFixture")).map((r) => ({ name: r.name, state: r.state.kind })) });
export const restRows = internalQuery({ args: {}, handler: async (ctx) => (await ctx.db.query("opsMetrics").collect()).filter((r) => r.route === "rest").map((r) => ({ minute: r.minute, status: r.status, serverErrors: r.serverErrors })) });
`;

const result = await withLocalCore(async ({ site, run, scratch, root }) => {
  const cli = join(root, 'node_modules/convex/bin/main.js');
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CONVEX_AGENT_MODE: 'anonymous', CI: '1', CONVEX_DISABLE_METRICS: '1' };
  const setting = (key, value) => execFileSync(process.execPath, [cli, 'env', 'set', key, value], { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  const waitFor = async (check, label, timeout = 30_000) => { const deadline = Date.now() + timeout; let v; while (!(v = await check())) { assert.ok(Date.now() < deadline, `Timeout: ${label}`); await pause(250); } return v; };
  const httpPath = join(scratch, 'convex/http.ts');
  writeFileSync(httpPath, 'declare const process: { env: Record<string, string | undefined> };\n' + readFileSync(httpPath, 'utf8').replace('async function dispatch(ctx: any, request: Request) {', `async function dispatch(ctx: any, request: Request) {
  if (new URL(request.url).pathname === "/api/v1/alert-fixture") { if (process.env.ALERT_FIXTURE_REST_FAIL === "1") throw new Error("Synthetic REST failure"); return json({ ok: true }); }`));
  writeFileSync(join(scratch, 'convex/alertFixture.ts'), fixture);
  await waitFor(() => { try { return run('alertFixture:scheduled') !== null; } catch { return false; } }, 'fixture deployed', 60_000);
  const hasAlerts = existsSync(join(scratch, 'convex/alerts.ts'));
  const rest = async () => (await fetch(`${site}/api/v1/alert-fixture?private=${encodeURIComponent(EMAIL)}`, { headers: { authorization: `Bearer ${SECRET}` } })).status;
  const bodies = () => received.map(r => JSON.parse(r.body));
  const notices = (event, kind) => bodies().filter(b => b.event === event && (!kind || b.kind === kind));
  const checks = [];
  // Async on purpose: the sink shares this process, and a synchronous CLI call blocks
  // it until the backend's 10s send timeout (see service-run-blocked-sink-failure.txt).
  const check = async () => { const started = Date.now(); const r = JSON.parse((await promisify(execFile)(process.execPath, [cli, 'run', 'alerts:check', '{}'], { cwd: scratch, env, timeout: 60_000 })).stdout); checks.push({ started, ended: Date.now(), ...r }); if (process.env.ALERTS_DEBUG) console.error('check', JSON.stringify(checks.at(-1))); return r; };

  setting('ALERT_FIXTURE_FAIL', '1'); setting('ALERT_FIXTURE_REST_FAIL', '1');
  if (!baseline) {
    setting('REMOLD_ALERT_WEBHOOK_URL', `http://127.0.0.1:${SINK_PORT}/hook`);
    setting('REMOLD_ALERT_STALL_MS', '3000');
    setting('REMOLD_ALERT_WINDOW_MINUTES', '1');
  }

  if (baseline) {
    run('alertFixture:kick', { note: NOTE });
    const restStatus = await rest();
    run('alertFixture:kickSlow', { note: NOTE, ms: 20_000 });
    await waitFor(() => run('alertFixture:restRows').some(r => r.status === '500'), 'REST 500 metric');
    console.log('Baseline: waiting 75s (more than one cron minute) for any notification.');
    await pause(75_000);
    return { status: 'BASELINE', level: 'SERVICE disposable local Convex, synthetic faults', alertModulePresent: hasAlerts, restStatus, scheduled: run('alertFixture:scheduled'), restRows: run('alertFixture:restRows'), sinkReceived: received.length, observation: 'Faults are recorded (failed scheduled row, REST 500 metric, long-running action) but nothing notifies anyone.' };
  }

  assert.ok(hasAlerts, 'alerts module missing');
  const steps = {};
  // 1. Background failure, delivered by the cron alone (no manual check).
  run('alertFixture:kick', { note: NOTE });
  await waitFor(() => run('alertFixture:scheduled').some(r => r.name.includes('job') && r.state === 'failed'), 'failed background run');
  const t0 = Date.now();
  await waitFor(() => notices('open', 'background-error').length, 'cron delivers background alert', 75_000);
  steps.background = { deliveredByCronAfterMs: Date.now() - t0, open: notices('open', 'background-error') };
  // Repeat failure and repeated checks: still one open notification.
  run('alertFixture:kick', { note: NOTE });
  await waitFor(() => run('alertFixture:scheduled').filter(r => r.name.includes('job') && r.state === 'failed').length >= 2, 'second failure');
  await check(); await check();
  assert.equal(notices('open', 'background-error').length, 1, 'background alert deduped');

  // 2. Caught REST 500.
  assert.equal(await rest(), 500);
  await waitFor(async () => (await check(), notices('open', 'rest-500').length), 'REST 500 alert');
  const restMinute = Math.floor(Date.now() / 60_000);
  assert.equal(await rest(), 500);
  await waitFor(() => run('alertFixture:restRows').reduce((n, r) => n + (r.status === '500' ? r.serverErrors : 0), 0) >= 2, 'second 500 recorded');
  await check();
  assert.equal(notices('open', 'rest-500').length, 1, 'REST alert deduped');
  steps.rest = { open: notices('open', 'rest-500') };

  // 3. Stalled scheduled action (runs 25s, stall threshold 3s).
  run('alertFixture:kickSlow', { note: NOTE, ms: 25_000 });
  const slowStarted = Date.now();
  await pause(5_000);
  await waitFor(async () => (await check(), notices('open', 'stalled').length), 'stall alert');
  await check();
  assert.equal(notices('open', 'stalled').length, 1, 'stall alert deduped');
  steps.stalled = { open: notices('open', 'stalled') };

  const opens = notices('open');
  assert.deepEqual(opens.map(n => n.kind).sort(), ['background-error', 'rest-500', 'stalled'], 'exactly three separate open alerts');
  assert.equal(new Set(opens.map(n => n.key)).size, 3);
  assert.equal(notices('resolve').length, 0, 'nothing resolved while faults persist');
  const leaked = () => FORBIDDEN.filter(f => received.map(r => r.body + JSON.stringify(r.headers)).join('\n').includes(f));
  assert.deepEqual(leaked(), [], 'open notifications scrubbed');

  // 4. Recovery: fixed background job succeeds, REST returns 200, slow action finishes.
  setting('ALERT_FIXTURE_FAIL', '0'); setting('ALERT_FIXTURE_REST_FAIL', '0');
  run('alertFixture:kick', { note: NOTE });
  await waitFor(() => run('alertFixture:scheduled').some(r => r.name.includes('job') && r.state === 'success'), 'background success');
  assert.equal(await rest(), 200);
  await waitFor(() => Date.now() - slowStarted > 27_000 && run('alertFixture:scheduled').some(r => r.name.includes('slow') && r.state === 'success'), 'slow action finished', 60_000);
  await check();
  const earlyResolves = notices('resolve').map(n => n.kind).sort();
  console.log('Waiting for the REST window (previous and current minute) to pass the last 500.');
  await waitFor(() => Math.floor(Date.now() / 60_000) >= restMinute + 2, 'REST window passes', 200_000);
  await check();
  const resolves = notices('resolve');
  assert.deepEqual(resolves.map(n => n.kind).sort(), ['background-error', 'rest-500', 'stalled'], 'each alert resolves once');
  await check();
  assert.equal(notices('resolve').length, 3, 'resolve deduped');
  const status = run('alerts:status');
  assert.equal(status.open.length, 0);
  assert.equal(status.undelivered, 0);

  // 5. Content scrub over every raw byte delivered to the sink.
  const leaks = leaked();
  assert.deepEqual(leaks, [], 'notification content scrubbed');
  return { status: 'PASS', level: 'SERVICE disposable local Convex, synthetic faults, local HTTP sink (not the owner channel)', steps, earlyResolves, resolves, finalStatus: status, deliveredCount: received.length, forbiddenChecked: FORBIDDEN, leaks, checks, sink: received.map(r => ({ path: r.path, contentType: r.headers['content-type'], body: JSON.parse(r.body) })) };
}, { cloudPort: Number(process.env.IV_CLOUD_PORT ?? 3910), sitePort: Number(process.env.IV_SITE_PORT ?? 3911) }).catch(error => { console.error('Sink at failure:', JSON.stringify(received.map(r => ({ at: r.at, headers: r.headers, body: r.body })))); throw error; }).finally(() => sink.close());

mkdirSync(join(out, '..'), { recursive: true });
writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ status: result.status, delivered: result.deliveredCount ?? result.sinkReceived, out }));
