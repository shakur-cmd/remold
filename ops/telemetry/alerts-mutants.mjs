// One mutant per alert guard. Each mutant edits convex/alerts.ts, runs the alert
// unit tests, and must make them fail. The source is always restored. The
// error-text scrub mutant needs real Convex (convex-test stores no error text), so
// it runs against the service rehearsal instead: see the handover.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('../../convex/alerts.ts', import.meta.url));
const root = fileURLToPath(new URL('../..', import.meta.url));
const original = readFileSync(path, 'utf8');
const mutants = [
  ['scrub: arguments forwarded', 'const kind = r.state.kind, fn = fnName(r.name);', 'const kind = r.state.kind, fn = fnName(r.name) + JSON.stringify(r.args);'],
  ['dedupe: open alert re-notifies', 'await ctx.db.patch(current._id, { count: c.count }); continue;', 'await ctx.db.patch(current._id, { count: c.count });'],
  ['dedupe: overlapping checks both apply (no watermark compare-and-set)', 'if ((cursor?.scannedThrough ?? null) !== args.from) return false;', ''],
  ['trigger: background failure ignored', 'if (h.lastFailed && h.lastAt', 'if (false && h.lastAt'],
  ['trigger: caught REST 500 ignored', 'r.route === "rest" && r.status === "500"', 'r.route === "rest" && r.status === "999"'],
  ['trigger: 503 migration pause alerts', 'r.route === "rest" && r.status === "500")', 'r.route === "rest")'],
  ['trigger: stall ignored', 'const late = (due: number) => due < now - stallMs;', 'const late = (_due: number) => false;'],
  ['stall: flag not persisted on already-watched jobs', 'for (const id of args.watchStalled) if (await ctx.db.get(id)) await ctx.db.patch(id, { stalledAt: now });', ''],
  ['coverage: unreadable REST window resolves the REST alert', 'args.restErrors ?? open.find((a) => a.key === "rest-500")?.count ?? 0', 'args.restErrors ?? 0'],
  ['stall: measured from creation, not due time', 'pending.push({ jobId: r._id, fn, due: r.scheduledTime })', 'pending.push({ jobId: r._id, fn, due: r._creationTime })'],
  ['stall: unfinished jobs not watched (resolves by leaving the scan)', 'for (const w of args.watchAdd) await ctx.db.insert("opsAlertWatch", w);', ''],
  ['coverage: exhausted scan budget not flagged', 'watchAdd.length >= MAX_WATCH_ADD || Date.now() > now + READ_BUDGET_MS) { behind = true; break; }', 'watchAdd.length >= MAX_WATCH_ADD || Date.now() > now + READ_BUDGET_MS) { break; }'],
  ['coverage: unread overdue jobs not flagged', 'await pass(-1, now - stallMs, true);', 'await pass(-1, now - stallMs, false);'],
  ['coverage: recently due backlog flagged as behind', 'await pass(now - stallMs, now, false);', 'await pass(now - stallMs, now, true);'],
  ['retention: old notices never deleted', 'q.lt("_creationTime", now - RETAIN_MS)', 'q.lt("_creationTime", 0)'],
  ['resolve: background never recovers on success', 'lastFailed: s.lastFailed, failures', 'lastFailed: s.lastFailed || !!row?.lastFailed, failures'],
  ['resolve: alerts never resolve', 'if (found.some((c) => c.key === alert.key)) continue;', 'continue;'],
  ['delivery: failed send marked delivered', 'settle, { id: next.id, delivered: ok }', 'settle, { id: next.id, delivered: true }'],
  ['delivery: claimed notice claimable again', '.find((n) => (n.claimedUntil ?? 0) <= now)', '.find(() => true)'],
  ['delivery: claim shorter than a slow send', 'CLAIM_MS = 5 * 60_000', 'CLAIM_MS = 60_000'],
  ['delivery: redirects followed', 'redirect: "error", ', ''],
  ['channel: 0.0.0.0 accepted as loopback', 'url.hostname === "127.0.0.1" || url.hostname === "localhost"', 'url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "0.0.0.0"'],
  ['channel: any hostname starting with localhost', 'url.hostname === "127.0.0.1" || url.hostname === "localhost"', 'url.hostname === "127.0.0.1" || url.hostname.startsWith("localhost")'],
  ['channel: any non-http scheme accepted', 'return url.protocol === "https:" && !internalHost', 'return url.protocol !== "http:" && !internalHost'],
  ['channel: HTTPS to private or link-local hosts accepted', '&& !internalHost(url.hostname) ? url.href', '? url.href'],
];
const results = [];
try {
  for (const [name, from, to] of mutants) {
    assert.ok(original.includes(from), `mutant anchor missing: ${name}`);
    writeFileSync(path, original.replace(from, to));
    const run = spawnSync('pnpm', ['vitest', 'run', 'convex/alerts.test.ts'], { cwd: root, encoding: 'utf8' });
    const failed = (run.stdout + run.stderr).match(/Tests\s+(\d+) failed/)?.[1];
    results.push({ name, exit: run.status, failedTests: Number(failed ?? 0), killed: run.status !== 0 });
    console.log(`${run.status !== 0 ? 'KILLED ' : 'SURVIVED'} ${name} (${failed ?? 0} failing tests)`);
  }
} finally { writeFileSync(path, original); }
const green = spawnSync('pnpm', ['vitest', 'run', 'convex/alerts.test.ts'], { cwd: root, encoding: 'utf8' });
console.log(JSON.stringify({ mutants: results.length, killed: results.filter(r => r.killed).length, survived: results.filter(r => !r.killed).map(r => r.name), restoredSourceGreen: green.status === 0 }));
process.exit(results.every(r => r.killed) && green.status === 0 ? 0 : 1);
