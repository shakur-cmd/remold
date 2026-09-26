// Breaks one guard at a time in a throwaway copy and requires the named check to fail.
// A mutant that leaves its check green means that check proves nothing.
import { cpSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const work = fileURLToPath(new URL('../.p6-mutant/', import.meta.url));
const T = {
  iso: 'isolation: each tenant sandbox sees only its own workspace, no network, no host paths or secrets',
  cap: 'missing cap means zero: no executor cap refuses before any reservation',
  budget: 'concurrent reservations never exceed org or global hard caps',
  orgKill: 'org kill switch stops the running sandbox within the bound, refuses queued work, leaves the other tenant running',
  cancel: 'cancel stops a running sandbox; a result reported after cancel is recorded as late and has no effect',
  orgRace: 'an org kill landing just before the result is applied never applies it (8 tries)',
  globalRace: 'a global kill landing just before the result is applied never applies it',
  revoke: 'revoking the agent grant mid-run stops the sandbox within the bound and applies nothing',
  replay: 'a replayed result never applies or bills twice',
  under: 'a guest that under-reports usage is billed the executor meter, flagged, and not applied',
  globalKill: 'global kill switch stops every running sandbox within the bound and refuses new runs',
  usage: 'missing usage report fails closed for that tenant only',
  limits: 'token overshoot and duration limits stop the sandbox and fail visibly',
};
const mutants = [
  ['sandbox network', 'executor.mjs', `'--network', 'none',`, `'--network', 'bridge',`, T.iso],
  ['sandbox volume selection', 'executor.mjs', 'type=volume,src=${volume},dst=/work', "type=volume,src=${volume.replace(/-B$/, '-A')},dst=/work", T.iso],
  ['sandbox environment', 'executor.mjs', `'--read-only',`, `'--read-only', '-e', 'REMOLD_ADAPTER_TOKEN=' + label,`, T.iso],
  ['read-only root filesystem', 'executor.mjs', `'--read-only', `, '', T.iso],
  ['non-root user', 'executor.mjs', `'--user', '65534:65534'`, `'--user', '0:0'`, T.iso],
  ['missing cap means zero', 'executor.mjs', 'maxUnitsPerRun ?? 0', 'maxUnitsPerRun ?? Infinity', T.cap],
  ['release undispatched claim', 'executor.mjs', `await call('cancel', { token: t.agent, id }).catch(() => {});`, '', T.budget],
  ['H0 org and global budget cap', 'convex/harness.ts', 'org.reserved + org.spent + op.reservationUnits > org.cap', 'false', T.budget, ['global.reserved + global.spent + op.reservationUnits > global.cap', 'false']],
  ['H0 one dispatch per org', 'convex/harness.ts', 'if (active.length >= 1)', 'if (false)', T.budget],
  ['kill watcher', 'executor.mjs', 'if (status.cancel) kill(box, \'cancel\');', '', T.orgKill],
  ['global kill switch', 'executor.mjs', `for (const box of running) kill(box, 'global');`, '', T.globalKill, [`if (!hosted) return kill(box, 'global');`, '']],
  ['status re-checked inside the apply transaction', 'convex/settle.ts', '!a.killed && !cancelled && usage', '!a.killed && usage', T.orgRace],
  ['global kill checked when the apply is sent', 'executor.mjs', 'const killed = !!box.killed || !hosted;', 'const killed = !!box.killed;', T.globalRace],
  ['H0 status treats lost authority as cancel (throwaway copy)', 'convex/harness.ts', 'catch {\n            cancel = true;\n        }', 'catch { }', T.revoke],
  ['bill at least the executor meter', 'convex/settle.ts', 'Math.max(a.meter, a.reported)', 'a.reported', T.under],
  ['under-report flagged and not applied', 'convex/settle.ts', 'const underreport = a.reported !== undefined && a.reported < a.meter;', 'const underreport = false;', T.under],
  ['missing usage stays missing', 'convex/settle.ts', 'a.reported === undefined ? undefined :', 'a.reported === undefined ? a.meter :', T.usage],
  ['token limit', 'executor.mjs', `if (b.tokens > request.maxUnits && !b.done) kill(b, 'tokens');`, '', T.limits],
  ['duration limit', 'executor.mjs', `setTimeout(() => kill(box, 'duration'), duration)`, 'setTimeout(() => {}, duration)', T.limits],
];

const only = process.argv[2];
const summary = [];
for (const [name, file, find, replace, expected, extra] of mutants) {
  if (only && name !== only) continue;
  rmSync(work, { recursive: true, force: true });
  cpSync(here, work, { recursive: true, verbatimSymlinks: true, filter: src => !src.includes('/evidence/mutants') });
  let source = readFileSync(work + file, 'utf8');
  for (const [a, b] of [[find, replace], ...(extra ? [extra] : [])]) {
    if (source.split(a).length !== 2) throw new Error(`mutant "${name}" target not found exactly once: ${a}`);
    source = source.replace(a, b);
  }
  writeFileSync(work + file, source);
  const resultsPath = work + 'evidence/mutant-results.json';
  const run = spawnSync(process.execPath, ['run.mjs'], { cwd: work, env: { ...process.env, P6_MUTANT: name, P6_RESULTS: resultsPath }, encoding: 'utf8', timeout: 400000 });
  const results = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, 'utf8')).results : [];
  const target = results.find(r => r.name === expected);
  const failed = results.filter(r => r.status === 'FAIL').map(r => r.name);
  const killed = run.status !== 0 && target?.status === 'FAIL';
  summary.push({ mutant: name, file, expectedFailure: expected, killed, exit: run.status, failed, error: target?.error });
  console.log(killed ? 'KILLED  ' : 'SURVIVED', name, '->', target?.error?.split('\n')[0] ?? run.stderr.slice(-400));
}
rmSync(work, { recursive: true, force: true });
if (!only) writeFileSync(here + 'evidence/mutants.json', JSON.stringify({ at: new Date().toISOString(), summary }, null, 2) + '\n');
process.exitCode = summary.length && summary.every(s => s.killed) ? 0 : 1;
