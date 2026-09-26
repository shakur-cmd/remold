// IV r2: thousands of jobs overdue at once (stall threshold 1 s, contended backlog).
// Does apply stay within Convex limits, does coverage/stall open, and does it recover?
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withLocalCore } from '../../../../../ops/rehearsal/local-core.mjs';
const out = process.argv.find(a => a.startsWith('--out='))?.slice(6) ?? '/tmp/iv2/stall-storm.json';
const pause = ms => new Promise(r => setTimeout(r, ms));
const fixture = `import { internalMutation, internalQuery } from "./_generated/server";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
const hotRef = makeFunctionReference<"mutation">("ivStorm:hot");
// Every job rewrites the same document, so the backlog drains slowly (like telemetry:record).
export const hot = internalMutation({ args: {}, handler: async (ctx) => { const d = await ctx.db.query("opsAlertScan").first(); void d; const row = await ctx.db.query("opsProbes").first(); if (row) await ctx.db.patch(row._id, { minute: row.minute }); else await ctx.db.insert("opsProbes", { minute: Math.floor(Date.now() / 60000), result: "unconfigured" }); } });
export const kick = internalMutation({ args: { n: v.number() }, handler: async (ctx, { n }) => { for (let i = 0; i < n; i++) await ctx.scheduler.runAfter(0, hotRef, {}); } });
export const watch = internalQuery({ args: {}, handler: async (ctx) => { const rows = await ctx.db.query("opsAlertWatch").take(3900); return { rows: rows.length, stalled: rows.filter(r => r.stalledAt !== undefined).length }; } });
`;
const result = await withLocalCore(async ({ run, scratch, root }) => {
  const cli = join(root, 'node_modules/convex/bin/main.js');
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CONVEX_AGENT_MODE: 'anonymous', CI: '1', CONVEX_DISABLE_METRICS: '1' };
  const check = async () => { try { return JSON.parse((await promisify(execFile)(process.execPath, [cli, 'run', 'alerts:check', '{}'], { cwd: scratch, env, timeout: 120_000 })).stdout); } catch (e) { return { error: String(e.stderr ?? e).slice(0, 300) }; } };
  writeFileSync(join(scratch, 'convex/ivStorm.ts'), fixture);
  const end = Date.now() + 90_000; while (true) { try { run('ivStorm:watch'); break; } catch { assert.ok(Date.now() < end); await pause(500); } }
  execFileSync(process.execPath, [cli, 'env', 'set', 'REMOLD_ALERT_STALL_MS', '1000'], { cwd: scratch, env, stdio: 'ignore' });
  for (let i = 0; i < 6; i++) run('ivStorm:kick', { n: 999 });
  const t0 = Date.now(), samples = [];
  while (Date.now() - t0 < 5 * 60_000) {
    await pause(12_000);
    const c = await check();
    let s, w; try { s = run('alerts:status'); } catch (e) { s = { error: String(e).slice(0, 200) }; } try { w = run('ivStorm:watch'); } catch (e) { w = { error: String(e).slice(0, 200) }; }
    samples.push({ t: Date.now() - t0, check: c, open: s.open?.map(a => `${a.key}(${a.count})`), scannedThrough: s.scannedThrough, watch: w });
    if (!c.behind && !c.error && (w.rows ?? 1) === 0) break;
  }
  return { samples };
}, { cloudPort: 3967, sitePort: 3968 });
writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result.samples.map(s => [s.t, s.check.applied, s.check.behind, s.check.error?.slice(0, 80), s.watch, s.open])));
