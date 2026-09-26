// IV r2: six overlapping checks racing to open fresh keys, after the 10 s commit lag,
// three rounds. Expect one alert row and one delivered open per key, no duplicate ids.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withLocalCore } from '../../../../../ops/rehearsal/local-core.mjs';
const out = process.argv.find(a => a.startsWith('--out='))?.slice(6) ?? '/tmp/iv2/concurrent.json';
const pause = ms => new Promise(r => setTimeout(r, ms));
const got = [];
const sink = createServer((req, res) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { got.push(JSON.parse(b)); res.writeHead(204).end(); }); });
await new Promise(r => sink.listen(3962, '127.0.0.1', r));
const fixture = `import { internalMutation, internalQuery } from "./_generated/server";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
export const f1 = internalMutation({ args: {}, handler: async () => { throw new Error("x"); } });
export const f2 = internalMutation({ args: {}, handler: async () => { throw new Error("x"); } });
export const f3 = internalMutation({ args: {}, handler: async () => { throw new Error("x"); } });
export const kick = internalMutation({ args: { n: v.string() }, handler: async (ctx, { n }) => { await ctx.scheduler.runAfter(0, makeFunctionReference<"mutation">("ivCc:" + n), {}); } });
export const rows = internalQuery({ args: {}, handler: async (ctx) => (await ctx.db.query("opsAlerts").collect()).map(a => a.key) });
`;
const result = await withLocalCore(async ({ run, scratch, root }) => {
  const cli = join(root, 'node_modules/convex/bin/main.js');
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CONVEX_AGENT_MODE: 'anonymous', CI: '1', CONVEX_DISABLE_METRICS: '1' };
  execFileSync(process.execPath, [cli, 'env', 'set', 'REMOLD_ALERT_WEBHOOK_URL', 'http://127.0.0.1:3962/hook'], { cwd: scratch, env, stdio: 'ignore' });
  const check = async () => { try { return JSON.parse((await promisify(execFile)(process.execPath, [cli, 'run', 'alerts:check', '{}'], { cwd: scratch, env, timeout: 120_000 })).stdout); } catch (e) { return { error: String(e.stderr ?? e).slice(0, 300) }; } };
  writeFileSync(join(scratch, 'convex/ivCc.ts'), fixture);
  const end = Date.now() + 90_000; while (true) { try { run('ivCc:rows'); break; } catch { assert.ok(Date.now() < end); await pause(500); } }
  const rounds = [];
  for (const n of ['f1', 'f2', 'f3']) {
    run('ivCc:kick', { n }); await pause(12_000);
    const results = await Promise.all(Array.from({ length: 6 }, () => check()));
    rounds.push({ n, results: results.map(r => ({ applied: r.applied, delivered: r.delivered, error: r.error })) });
  }
  await pause(3000);
  const keys = run('ivCc:rows');
  return { rounds, alertRows: keys, perKey: Object.fromEntries([...new Set(keys)].map(k => [k, keys.filter(x => x === k).length])), sink: got.map(g => ({ id: g.id, event: g.event, key: g.key })), duplicateIds: got.map(g => g.id).filter((id, i, a) => a.indexOf(id) !== i) };
}, { cloudPort: 3958, sitePort: 3959 }).finally(() => sink.close());
writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ perKey: result.perKey, dup: result.duplicateIds, opens: result.sink.filter(s => s.event === 'open').map(s => s.key) }));
