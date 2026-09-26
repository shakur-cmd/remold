// One mutant per alert guard. Each mutant edits convex/alerts.ts, runs the alert
// unit tests, and must make them fail. The source is always restored.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('../../convex/alerts.ts', import.meta.url));
const root = fileURLToPath(new URL('../..', import.meta.url));
const original = readFileSync(path, 'utf8');
const mutants = [
  ['scrub: error text forwarded', 'const fn = row.name.replace(/\\.js:/, ":"), state', 'const fn = row.name.replace(/\\.js:/, ":") + String((row as any).state.error ?? ""), state'],
  ['scrub: arguments forwarded', 'const fn = row.name.replace(/\\.js:/, ":"), state', 'const fn = row.name.replace(/\\.js:/, ":") + JSON.stringify((row as any).args ?? ""), state'],
  ['dedupe: open alert re-notifies', 'await ctx.db.patch(current._id, { count: c.count }); continue;', 'await ctx.db.patch(current._id, { count: c.count });'],
  ['trigger: background failure ignored', 'if (row.state.kind === "failed") add("background-error"', 'if (row.state.kind === "never") add("background-error"'],
  ['trigger: caught REST 500 ignored', 'r.route === "rest" && r.status === "500"', 'r.route === "rest" && r.status === "999"'],
  ['trigger: 503 migration pause alerts', 'r.route === "rest" && r.status === "500" && ', 'r.route === "rest" && '],
  ['trigger: stall ignored', 'row.scheduledTime < input.now - input.stallMs', 'false'],
  ['trigger: truncated scan silent', 'if (input.truncated) add', 'if (false) add'],
  ['resolve: background never recovers on success', 'for (const [fn, row] of latest) if (row.state.kind === "failed") add("background-error", fn, failures.get(fn));', 'for (const [fn, n] of failures) add("background-error", fn, n);'],
  ['resolve: alerts never resolve', 'if (found.some((c) => c.key === alert.key)) continue;', 'continue;'],
  ['delivery: overlapping checks both send', 'filter((n) => (n.claimedUntil ?? 0) <= now)', 'filter(() => true)'],
  ['delivery: failed send marked delivered', 'await ctx.runMutation(internal.alerts.settle, { id, delivered: ok });', 'await ctx.runMutation(internal.alerts.settle, { id, delivered: true });'],
  ['channel: non-loopback plain HTTP accepted', '(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))', 'url.protocol === "http:"'],
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
console.log(JSON.stringify({ mutants: results.length, killed: results.filter(r => r.killed).length, restoredSourceGreen: green.status === 0 }));
process.exit(results.every(r => r.killed) && green.status === 0 ? 0 : 1);
