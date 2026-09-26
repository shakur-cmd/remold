// Independent verifier mutants, different from the builder's 13. Each edits one
// source file, runs the builder's own guard (alert unit tests or the authority
// inventory tests), records KILLED/SURVIVED, and restores the file.
// Run from the repo root: node evidence/2026-09-26-i2-alerts/iv/scripts/iv-mutants.mjs
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const alertTests = ['vitest', 'run', 'convex/alerts.test.ts'];
const authorityTests = ['test:authority'];
const mutants = [
  ['channel: 0.0.0.0 accepted as loopback', 'convex/alerts.ts', '["127.0.0.1", "localhost"]', '["127.0.0.1", "localhost", "0.0.0.0"]', alertTests],
  ['channel: any hostname starting with localhost', 'convex/alerts.ts', '["127.0.0.1", "localhost"].includes(url.hostname)', 'url.hostname.startsWith("localhost") || url.hostname === "127.0.0.1"', alertTests],
  ['channel: any non-http scheme accepted (ftp, file)', 'convex/alerts.ts', 'url.protocol === "https:" ||', 'url.protocol !== "http:" ||', alertTests],
  ['stall: measured from creation, not due time', 'convex/alerts.ts', 'row.scheduledTime < input.now - input.stallMs', 'row._creationTime < input.now - input.stallMs', alertTests],
  ['stall: pending work never counted', 'convex/alerts.ts', '(state === "pending" || state === "inProgress")', '(state === "inProgress")', alertTests],
  ['coverage: evaluate never marks the scan truncated', 'convex/alerts.ts', 'truncated: scheduled.length === SCAN_CAP', 'truncated: scheduled.length > SCAN_CAP', alertTests],
  ['retention: old notices never deleted', 'convex/alerts.ts', 'q.lt("_creationTime", now - RETAIN_MS)).take(100)', 'q.lt("_creationTime", 0)).take(100)', alertTests],
  ['delivery: failed send keeps its claim', 'convex/alerts.ts', '{ attempts: row.attempts + 1, claimedUntil: undefined }', '{ attempts: row.attempts + 1 }', alertTests],
  ['delivery: claim taken even with no channel', 'convex/alerts.ts', '{ claim: url !== null }', '{ claim: true }', alertTests],
  ['resolve: resolve notice never queued', 'convex/alerts.ts', 'await ctx.db.insert("opsNotices", { payload: notice("resolve"', 'if (false) await ctx.db.insert("opsNotices", { payload: notice("resolve"', alertTests],
  ['dedupe: one key per kind, functions merged', 'convex/alerts.ts', 'const key = fn ? `${kind}:${fn}` : kind;', 'const key = kind;', alertTests],
  ['inventory: status becomes a public query', 'convex/alerts.ts', 'export const status = internalQuery({', 'export const status = query({', authorityTests, s => s.replace('import { internalAction, internalMutation, internalQuery } from "./_generated/server";', 'import { internalAction, internalMutation, internalQuery, query } from "./_generated/server";')],
  ['inventory: cron row removed', 'ops/authority/inventory.json', null, null, authorityTests, s => { const j = JSON.parse(s); return JSON.stringify(j.filter(r => r.id !== 'cron Operator alerts'), null, 2); }],
  ['inventory: cron renamed in crons.ts', 'convex/crons.ts', '"Operator alerts"', '"Operator alerts v2"', authorityTests],
  ['inventory: new unlisted internal function', 'convex/alerts.ts', 'export const status = internalQuery({', 'export const purge = internalMutation({ args: {}, handler: async () => {} });\nexport const status = internalQuery({', authorityTests],
  ['inventory: evaluate row claims query/no-writes', 'ops/authority/inventory.json', null, null, authorityTests, s => { const j = JSON.parse(s); const r = j.find(r => r.id === 'alerts:evaluate'); r.kind = 'query'; r.writes = false; return JSON.stringify(j, null, 2); }],
];
const results = [];
for (const [name, file, from, to, cmd, fnEdit] of mutants) {
  const original = readFileSync(file, 'utf8');
  try {
    let mutated = original;
    if (from !== null) { assert.ok(original.includes(from), 'anchor missing: ' + name); mutated = original.replace(from, to); }
    if (fnEdit) mutated = fnEdit(mutated);
    assert.notEqual(mutated, original, 'no change: ' + name);
    writeFileSync(file, mutated);
    const r = spawnSync('pnpm', cmd, { encoding: 'utf8' });
    const failed = (r.stdout + r.stderr).match(/Tests\s+(\d+) failed/)?.[1] ?? '0';
    results.push({ name, guard: cmd.join(' '), killed: r.status !== 0, failedTests: Number(failed) });
    console.log(`${r.status !== 0 ? 'KILLED  ' : 'SURVIVED'} ${name} [${cmd.join(' ')}] (${failed} failing)`);
  } finally { writeFileSync(file, original); }
}
const greenA = spawnSync('pnpm', alertTests, { encoding: 'utf8' }).status === 0;
const greenB = spawnSync('pnpm', authorityTests, { encoding: 'utf8' }).status === 0;
console.log(JSON.stringify({ mutants: results.length, killed: results.filter(r => r.killed).length, survived: results.filter(r => !r.killed).map(r => r.name), restoredGreen: greenA && greenB }));
