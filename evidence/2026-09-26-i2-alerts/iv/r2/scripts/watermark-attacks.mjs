// IV r2: watermark, watch-list and timestamp attacks on the reworked alerts (117917d).
// Disposable anonymous local Convex on loopback, synthetic data. Run from the repo root
// of the checkout under test: node <this file> --out=/tmp/x.json
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withLocalCore } from '../../../../../ops/rehearsal/local-core.mjs';

const out = process.argv.find(a => a.startsWith('--out='))?.slice(6) ?? '/tmp/iv2/watermark.json';
const pause = ms => new Promise(r => setTimeout(r, ms));
const fixture = `import { internalMutation, internalQuery, internalAction } from "./_generated/server";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
const noopRef = makeFunctionReference<"mutation">("ivWm:noop");
const failTieRef = makeFunctionReference<"mutation">("ivWm:failTie");
const failBigRef = makeFunctionReference<"mutation">("ivWm:failBig");
const failPastRef = makeFunctionReference<"mutation">("ivWm:failPast");
const failLongRef = makeFunctionReference<"mutation">("ivWm:failLong");
export const noop = internalMutation({ args: { pad: v.optional(v.string()) }, handler: async () => {} });
export const failTie = internalMutation({ args: {}, handler: async () => { throw new Error("x"); } });
export const failBig = internalMutation({ args: { pad: v.string() }, handler: async () => { throw new Error("x"); } });
export const failPast = internalMutation({ args: {}, handler: async () => { throw new Error("x"); } });
export const failLong = internalMutation({ args: {}, handler: async () => { throw new Error("x"); } });
// n no-ops then one failure, all in one transaction (Convex allows 1000 per mutation).
export const tie = internalMutation({ args: { n: v.number() }, handler: async (ctx, { n }) => { for (let i = 0; i < n; i++) await ctx.scheduler.runAfter(0, noopRef, {}); await ctx.scheduler.runAfter(0, failTieRef, {}); } });
// Large rows force the scan to shrink its page; a failure closes each batch.
export const big = internalMutation({ args: { n: v.number(), size: v.number() }, handler: async (ctx, { n, size }) => { const pad = "y".repeat(size); for (let i = 0; i < n; i++) await ctx.scheduler.runAfter(0, noopRef, { pad }); await ctx.scheduler.runAfter(0, failBigRef, { pad }); } });
export const past = internalMutation({ args: { agoMs: v.number() }, handler: async (ctx, { agoMs }) => { await ctx.scheduler.runAt(Date.now() - agoMs, failPastRef, {}); } });
export const future = internalMutation({ args: { n: v.number(), inMs: v.number() }, handler: async (ctx, { n, inMs }) => { for (let i = 0; i < n; i++) await ctx.scheduler.runAfter(inMs, noopRef, {}); } });
// Spend most of the mutation time budget before scheduling, to see which timestamp the row gets.
export const slowSchedule = internalMutation({ args: {}, handler: async (ctx) => { const started = Date.now(); let x = 0; for (let i = 0; i < 30_000_000; i++) x += i % 7; /* Date.now() is frozen inside a mutation, so spin on a count */ const id = await ctx.scheduler.runAfter(0, failLongRef, {}); return { started, id, x }; } });
export const job = internalQuery({ args: { id: v.id("_scheduled_functions") }, handler: async (ctx, { id }) => { const r = await ctx.db.system.get(id); return r && { creationTime: r._creationTime, scheduledTime: r.scheduledTime, state: r.state.kind }; } });
export const times = internalQuery({ args: { name: v.string(), after: v.number() }, handler: async (ctx, { name, after }) => { const rows = await ctx.db.system.query("_scheduled_functions").withIndex("by_creation_time", q => q.gt("_creationTime", after)).take(3000); const mine = rows.filter(r => r.name.startsWith(name)); return { n: mine.length, distinct: new Set(mine.map(r => r._creationTime)).size, first: mine[0]?._creationTime ?? null, last: mine.at(-1)?._creationTime ?? null, lastRow: rows.at(-1)?._creationTime ?? null }; } });
export const alertTables = internalQuery({ args: {}, handler: async (ctx) => ({ functions: await ctx.db.query("opsAlertFunctions").collect(), watch: (await ctx.db.query("opsAlertWatch").take(4000)).length, open: (await ctx.db.query("opsAlerts").collect()).filter(a => a.state === "open").map(a => ({ key: a.key, count: a.count })) }) });
`;

const result = await withLocalCore(async ({ run, scratch, root }) => {
  const cli = join(root, 'node_modules/convex/bin/main.js');
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CONVEX_AGENT_MODE: 'anonymous', CI: '1', CONVEX_DISABLE_METRICS: '1' };
  const setting = (k, v) => execFileSync(process.execPath, [cli, 'env', 'set', k, v], { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  const check = async () => { try { return JSON.parse((await promisify(execFile)(process.execPath, [cli, 'run', 'alerts:check', '{}'], { cwd: scratch, env, timeout: 120_000 })).stdout); } catch (e) { return { error: String(e.stderr ?? e).slice(0, 400) }; } };
  writeFileSync(join(scratch, 'convex/ivWm.ts'), fixture);
  const deadline = Date.now() + 90_000;
  while (true) { try { run('ivWm:alertTables'); break; } catch { assert.ok(Date.now() < deadline, 'fixture deploy'); await pause(500); } }
  setting('REMOLD_ALERT_STALL_MS', '120000');
  const settle = async (label, max = 8) => { const checks = []; for (let i = 0; i < max; i++) { await pause(11_000); const c = await check(); checks.push(c); if (!c.behind && !c.error) break; } return checks; };
  const phases = {};
  const mark = run('ivWm:times', { name: 'zzz', after: 0 }).lastRow ?? 0;

  // 1. Same-transaction rows: are creation times distinct, and is a failure past a page boundary seen?
  run('ivWm:future', { n: 600, inMs: 0 }); // 600 rows first, so the next page boundary falls inside the tie transaction
  run('ivWm:tie', { n: 999 });
  phases.tie = { times: run('ivWm:times', { name: 'ivWm.js:noop', after: mark }), checks: await settle('tie') };
  phases.tie.alerts = run('ivWm:alertTables');

  // 2. Large rows: 10 batches of 100 x 16 KB, each ending in one failure (10 failures expected).
  const m2 = run('ivWm:times', { name: 'zzz', after: 0 }).lastRow ?? 0;
  for (let i = 0; i < 10; i++) { run('ivWm:big', { n: 100, size: 16_000 }); await pause(1500); } // local deployments cap writes at 4 MiB/s
  phases.big = { checks: await settle('big', 12) };
  phases.big.alerts = run('ivWm:alertTables');

  // 3. A failing job scheduled with a due time two hours in the past.
  run('ivWm:past', { agoMs: 2 * 60 * 60_000 });
  phases.past = { checks: await settle('past') };
  phases.past.alerts = run('ivWm:alertTables');

  // 4. Which timestamp does a row get when its mutation runs long before scheduling?
  const before = Date.now();
  const s = run('ivWm:slowSchedule');
  const after = Date.now();
  phases.slowCreation = { callStart: before, mutationStarted: s.started, callEnd: after, job: run('ivWm:job', { id: s.id }) };

  // 5. Watch-list growth: 6000 jobs due in one day.
  for (let i = 0; i < 6; i++) run('ivWm:future', { n: 999, inMs: 24 * 60 * 60_000 });
  phases.future = { checks: await settle('future', 8) };
  phases.future.watchRows = run('ivWm:alertTables').watch;
  phases.status = run('alerts:status');
  return { level: 'SERVICE disposable local Convex, synthetic', phases };
}, { cloudPort: Number(process.env.IV_CLOUD_PORT ?? 3954), sitePort: Number(process.env.IV_SITE_PORT ?? 3955) });
writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ out }));
