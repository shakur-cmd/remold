// Runs the real deploy script against a clone of this repo, with a stub pnpm on PATH that records
// every command and can fail one, so nothing reaches Convex or Cloudflare.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const target = { convexUrl: 'https://nautical-viper-899.convex.cloud', workosClientId: 'client_01DEPLOYTEST', workosRedirectUri: 'https://app.remoldcrm.com/callback', authSessionMode: 'staging-live' };
const deploys = log => log.filter(line => /convex deploy|wrangler/.test(line));

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'remold-deploy-run-')), work = join(dir, 'work'), origin = join(dir, 'origin.git'), bin = join(dir, 'bin');
  t.after(() => { spawnSync('git', ['worktree', 'prune'], { cwd: work }); rmSync(dir, { recursive: true, force: true }); });
  git(dir, 'clone', '-q', root, work);
  for (const file of ['ops/deploy/prod.mjs', 'ops/release/release.mjs', 'ops/release/snapshot.mjs']) cpSync(join(root, file), join(work, file));
  writeFileSync(join(work, 'ops/deploy/prod.json'), JSON.stringify(target));
  git(work, 'add', '-A'); git(work, 'commit', '-qm', 'scripts under test', '--allow-empty');
  git(dir, 'init', '-q', '--bare', origin); git(work, 'remote', 'set-url', 'origin', origin); git(work, 'push', '-q', 'origin', 'HEAD:refs/heads/release');
  mkdirSync(bin);
  writeFileSync(join(bin, 'pnpm'), `#!/bin/sh
echo "$*" >> ${join(dir, 'log')}
fail=$(cat ${join(dir, 'fail')} 2>/dev/null)
[ -n "$fail" ] && [ "$*" = "$fail" ] && exit 1
if [ "$1" = build ]; then mkdir -p dist/assets; printf '<script src="/assets/i.js"></script>' > dist/index.html; printf 'new C("%s");"%s"' "$VITE_CONVEX_URL" "$VITE_WORKOS_CLIENT_ID" > dist/assets/i.js; fi
exit 0
`);
  chmodSync(join(bin, 'pnpm'), 0o755);
  const run = (args, { fail } = {}) => {
    writeFileSync(join(dir, 'log'), ''); writeFileSync(join(dir, 'fail'), fail ?? '');
    const result = spawnSync(process.execPath, [join(work, 'ops/deploy/prod.mjs'), ...args], { cwd: work, encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CONVEX_DEPLOY_KEY: 'prod:nautical-viper-899|stub' } });
    return { ...result, log: readFileSync(join(dir, 'log'), 'utf8').split('\n').filter(Boolean) };
  };
  return { dir, work, run };
}

test('a passing deploy runs every check and the build, then Convex before the Worker', t => {
  const { run } = fixture(t), result = run([]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.log, ['install --frozen-lockfile --prefer-offline', 'typecheck', 'test', 'test:authority', 'verify:release', 'build', 'exec convex deploy -y', 'dlx wrangler@4.138.0 deploy']);
});

test('a dry run does everything but deploy', t => {
  const { run } = fixture(t), result = run(['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.log.includes('build'));
  assert.deepEqual(deploys(result.log), []);
  assert.match(result.stdout, /pnpm exec convex deploy -y\n\s+pnpm dlx wrangler@4.138.0 deploy/);
});

test('any failing check stops the deploy', t => {
  const { run } = fixture(t);
  for (const check of ['typecheck', 'test', 'test:authority', 'verify:release']) {
    const result = run([], { fail: check });
    assert.equal(result.status, 1, check);
    assert.deepEqual(deploys(result.log), [], `${check} failed but something deployed`);
    assert.ok(!result.log.includes('build'), `${check} failed but the build ran`);
  }
});

test('a rollback whose restore drill fails deploys nothing', t => {
  const { dir, work, run } = fixture(t), snapshot = join(dir, 'backup.zip'), src = join(dir, 'zip');
  mkdirSync(join(src, 'users'), { recursive: true }); writeFileSync(join(src, 'users/documents.jsonl'), '{"_id":"u1"}\n');
  execFileSync('zip', ['-qr', snapshot, '.'], { cwd: src });
  // The clone has no node_modules, so the drill's local backend cannot start and the drill reports FAIL.
  const result = run(['--ref', git(work, 'rev-parse', 'HEAD'), '--snapshot', snapshot]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /schema did not accept the backup/);
  assert.deepEqual(deploys(result.log), []);
  assert.ok(!result.log.includes('build'));
});

test('a rollback to code without the purge worker waits while a backup shows a deletion in progress', t => {
  const { dir, work, run } = fixture(t), target = JSON.parse(readFileSync(join(root, 'ops/release/notes.json'), 'utf8')).rollbackTarget;
  const zip = (name, org) => { const src = join(dir, name), out = join(dir, `${name}.zip`); mkdirSync(join(src, 'orgs'), { recursive: true }); writeFileSync(join(src, 'orgs/documents.jsonl'), JSON.stringify({ _id: 'org1', name: 'A', ...org }) + '\n'); execFileSync('zip', ['-qr', out, '.'], { cwd: src }); return out; };
  const pending = run(['--ref', target, '--snapshot', zip('pending', { deletingAt: 1 })]);
  assert.equal(pending.status, 1);
  assert.match(pending.stderr, /deletion\(s\) still in progress \(org1\)/);
  assert.deepEqual(pending.log, [], 'nothing may run, not even the install');
  // With no deletion pending the gate passes and the rollback goes on to its restore drill.
  const settled = run(['--ref', target, '--snapshot', zip('settled', {})]);
  assert.match(settled.stderr, /schema did not accept the backup/);
  // Code that has the purge worker may roll back over a pending deletion.
  assert.match(run(['--ref', git(work, 'rev-parse', 'HEAD'), '--snapshot', zip('newer', { deletingAt: 1 })]).stderr, /schema did not accept the backup/);
});
