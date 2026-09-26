// IV r2 mutants on 117917d: the IV's 16 from round 1 remapped to the new code, plus
// new ones for each round 2 fix. Each runs the builder's own guard and restores the file.
// Run from the repo root: node evidence/2026-09-26-i2-alerts/iv/r2/scripts/iv-mutants-r2.mjs
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const A = ['vitest', 'run', 'convex/alerts.test.ts'], AUTH = ['test:authority'], F = 'convex/alerts.ts', INV = 'ops/authority/inventory.json';
const inv = edit => s => { const j = JSON.parse(s); edit(j); return JSON.stringify(j, null, 2); };
const mutants = [
  // Round 1 set, remapped
  ['r1 channel: 0.0.0.0 accepted as loopback', F, 'url.hostname === "127.0.0.1" || url.hostname === "localhost" ?', 'url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "0.0.0.0" ?', A],
  ['r1 channel: any hostname starting with localhost', F, 'url.hostname === "127.0.0.1" || url.hostname === "localhost" ?', 'url.hostname === "127.0.0.1" || url.hostname.startsWith("localhost") ?', A],
  ['r1 channel: any non-http scheme accepted', F, 'return url.protocol === "https:" && !internalHost', 'return url.protocol !== "http:" && !internalHost', A],
  ['r1 stall: measured from creation, not due time', F, 'pending.push({ jobId: r._id, fn, due: r.scheduledTime })', 'pending.push({ jobId: r._id, fn, due: r._creationTime })', A],
  ['r1 stall: pending work never watched', F, 'else if (kind === "pending" || kind === "inProgress")', 'else if (kind === "inProgress")', A],
  ['r1 coverage: page cap not flagged', F, 'if (calls++ >= MAX_PAGES || watchAdd.length >= MAX_WATCH_ADD || Date.now() > now + READ_BUDGET_MS) { behind = true; break; }', 'if (calls++ >= MAX_PAGES || watchAdd.length >= MAX_WATCH_ADD || Date.now() > now + READ_BUDGET_MS) { break; }', A],
  ['r1 retention: old notices never deleted', F, 'q.lt("_creationTime", now - RETAIN_MS)', 'q.lt("_creationTime", 0)', A],
  ['r1 delivery: failed send keeps its claim', F, '{ attempts: row.attempts + 1, claimedUntil: undefined }', '{ attempts: row.attempts + 1 }', A],
  ['r1 resolve: resolve notice never queued', F, 'await ctx.db.insert("opsNotices", { payload: notice("resolve"', 'if (false) await ctx.db.insert("opsNotices", { payload: notice("resolve"', A],
  ['r1 dedupe: one key per kind, functions merged', F, 'key: `background-error:${h.fn}`', 'key: "background-error"', A],
  ['r1 inventory: status becomes a public query', F, 'export const status = internalQuery({', 'export const status = query({', AUTH, s => s.replace('import { internalAction, internalMutation, internalQuery } from "./_generated/server";', 'import { internalAction, internalMutation, internalQuery, query } from "./_generated/server";')],
  ['r1 inventory: cron row removed', INV, null, null, AUTH, inv(j => j.splice(j.findIndex(r => r.id === 'cron Operator alerts'), 1))],
  ['r1 inventory: cron renamed in crons.ts', 'convex/crons.ts', '"Operator alerts"', '"Operator alerts v2"', AUTH],
  ['r1 inventory: new unlisted internal function', F, 'export const status = internalQuery({', 'export const purge = internalMutation({ args: {}, handler: async () => {} });\nexport const status = internalQuery({', AUTH],
  ['r1 inventory: apply row claims query/no-writes', INV, null, null, AUTH, inv(j => { const r = j.find(r => r.id === 'alerts:apply'); r.kind = 'query'; r.writes = false; })],
  ['r1 inventory: scanPage made public', F, 'export const scanPage = internalQuery({', 'export const scanPage = query({', AUTH, s => s.replace('import { internalAction, internalMutation, internalQuery } from "./_generated/server";', 'import { internalAction, internalMutation, internalQuery, query } from "./_generated/server";')],
  // Round 2 fixes
  ['r2 watermark: truncated page jumps to the end of the range', F, 'through: done ? a.until : rows[rows.length - 1]!._creationTime', 'through: a.until', A],
  ['r2 watermark: boundary row re-read (gte)', F, 'q.gt("_creationTime", a.after)', 'q.gte("_creationTime", a.after)', A],
  ['r2 watermark: no commit lag', F, 'until: now - LAG_MS', 'until: now', A],
  ['r2 watermark: no compare-and-set but still writes', F, 'if ((cursor?.scannedThrough ?? null) !== args.from) return false;', '', A],
  ['r2 stall: running job counts as finished', F, 'if (w.state === "success" || w.state === "failed")', 'if (w.state !== "pending")', A],
  ['r2 stall: vanished job keeps the stall open', F, 'else watchDone.push(w.id);', '', A],
  ['r2 health: older outcome overwrites newer', F, 'if (row && s.lastAt < row.lastAt) continue;', '', A],
  ['r2 health: quiet failing function never resolves', F, 'h.lastFailed && h.lastAt >= input.now - LOOKBACK_MS', 'h.lastFailed', A],
  ['r2 rest: unreadable window treated as readable', F, 'rows.length === REST_ROWS ? null', 'false ? null', A],
  ['r2 claim: claim not recorded', F, 'await ctx.db.patch(next._id, { claimedUntil: now + CLAIM_MS });', '', A],
  ['r2 send: keeps sending after a failure', F, 'if (!ok) break;', '', A],
  ['r2 host: 0.x HTTPS accepted', F, 'return a === 0 || a === 10', 'return a === 10', A],
  ['r2 host: IPv4-mapped IPv6 accepted', F, ' || a.startsWith("::ffff:")', '', A],
  ['r2 host: CGNAT 100.64/10 accepted', F, ' || (a === 100 && b >= 64 && b <= 127)', '', A],
  ['r2 host: IPv6 link-local fe80 accepted', F, ' || /^fe[89ab]/.test(a)', '', A],
  ['r2 host: .local names accepted', F, '/\\.(localhost|local|internal)$/', '/\\.(localhost|internal)$/', A],
];
const results = [];
for (const [name, file, from, to, cmd, fnEdit] of mutants) {
  const original = readFileSync(file, 'utf8');
  try {
    let m = original;
    if (from !== null) { assert.ok(original.includes(from), 'anchor missing: ' + name); m = original.replace(from, to); }
    if (fnEdit) m = fnEdit(m);
    assert.notEqual(m, original, 'no change: ' + name);
    writeFileSync(file, m);
    const r = spawnSync('pnpm', cmd, { encoding: 'utf8' });
    const failed = (r.stdout + r.stderr).match(/Tests\s+(\d+) failed/)?.[1] ?? '0';
    results.push({ name, killed: r.status !== 0 });
    console.log(`${r.status !== 0 ? 'KILLED  ' : 'SURVIVED'} ${name} [${cmd.join(' ')}] (${failed} failing)`);
  } finally { writeFileSync(file, original); }
}
const green = spawnSync('pnpm', A, { encoding: 'utf8' }).status === 0 && spawnSync('pnpm', AUTH, { encoding: 'utf8' }).status === 0;
console.log(JSON.stringify({ mutants: results.length, killed: results.filter(r => r.killed).length, survived: results.filter(r => !r.killed).map(r => r.name), restoredGreen: green }));
