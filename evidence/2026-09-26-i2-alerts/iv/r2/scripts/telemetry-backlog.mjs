// IV r2: does the telemetry:record backlog after a REST burst drain, and does it
// lose or duplicate metrics? Runs the same way on base d66eb0b (no alerts) and on
// 117917d (alerts cron running). Disposable local Convex, synthetic traffic only.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withLocalCore } from '../../../../../ops/rehearsal/local-core.mjs';

const out = process.argv.find(a => a.startsWith('--out='))?.slice(6) ?? '/tmp/iv2/backlog.json';
const N = Number(process.env.IV_BURST ?? 5100);
const pause = ms => new Promise(r => setTimeout(r, ms));
const fixture = `import { internalQuery } from "./_generated/server";
import { v } from "convex/values";
export const page = internalQuery({ args: { after: v.number() }, handler: async (ctx, { after }) => {
  const rows = await ctx.db.system.query("_scheduled_functions").withIndex("by_creation_time", q => q.gt("_creationTime", after)).take(1500);
  const c: Record<string, number> = {};
  for (const r of rows) if (r.name.startsWith("telemetry")) c[r.state.kind] = (c[r.state.kind] ?? 0) + 1;
  return { c, last: rows.at(-1)?._creationTime ?? after, done: rows.length < 1500 };
} });
export const metrics = internalQuery({ args: {}, handler: async (ctx) => (await ctx.db.query("opsMetrics").take(3000)).filter(r => r.route === "rest").map(r => ({ minute: r.minute, status: r.status, count: r.count })) });
`;
const result = await withLocalCore(async ({ site, run, scratch }) => {
  writeFileSync(join(scratch, 'convex/ivBacklog.ts'), fixture);
  const end = Date.now() + 90_000;
  while (true) { try { run('ivBacklog:metrics'); break; } catch { if (Date.now() > end) throw new Error('deploy'); await pause(500); } }
  const states = () => { const total = {}; let after = 0; for (let i = 0; i < 20; i++) { const p = run('ivBacklog:page', { after }); for (const [k, v] of Object.entries(p.c)) total[k] = (total[k] ?? 0) + v; after = p.last; if (p.done) break; } return total; };
  const baseline = states();
  const t0 = Date.now(); let sent = 0; const statuses = {};
  await Promise.all(Array.from({ length: 50 }, async () => { while (sent < N) { sent++; const r = await fetch(`${site}/api/v1/me`).catch(() => null); const s = r?.status ?? 'err'; statuses[s] = (statuses[s] ?? 0) + 1; } }));
  const burstMs = Date.now() - t0;
  const samples = [];
  while (Date.now() - t0 < 12 * 60_000) {
    const s = states(); samples.push({ t: Date.now() - t0, ...s });
    if (!(s.pending ?? 0) && !(s.inProgress ?? 0)) break;
    await pause(10_000);
  }
  const rows = run('ivBacklog:metrics');
  const recorded = rows.reduce((n, r) => n + r.count, 0);
  return { sent, statuses, burstMs, baseline, samples, drainedMs: samples.at(-1).pending || samples.at(-1).inProgress ? null : samples.at(-1).t, restRecorded: recorded, rows };
}, { cloudPort: Number(process.env.IV_CLOUD_PORT ?? 3956), sitePort: Number(process.env.IV_SITE_PORT ?? 3957) });
writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ sent: result.sent, statuses: result.statuses, drainedMs: result.drainedMs, restRecorded: result.restRecorded, last: result.samples.at(-1) }));
