import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBundle, deployCommands, readTarget, releasable, requireDeployKey, rollbackFloor } from './prod.mjs';

const live = { convexUrl: 'https://nautical-viper-899.convex.cloud', workosClientId: 'client_01TESTVALUE', workosRedirectUri: 'https://app.remoldcrm.com/callback', authSessionMode: 'staging-live' };
const temp = t => { const dir = mkdtempSync(join(tmpdir(), 'remold-deploy-test-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const configFile = (t, values) => { const path = join(temp(t), 'prod.json'); writeFileSync(path, JSON.stringify(values)); return path; };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function repo(t) {
  const dir = temp(t), origin = join(dir, 'origin.git'), work = join(dir, 'work');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin); git(dir, 'clone', '-q', origin, work);
  const commit = name => { writeFileSync(join(work, name), name); git(work, 'add', name); git(work, 'commit', '-qm', name); return git(work, 'rev-parse', 'HEAD'); };
  return { work, origin, commit };
}

test('a prod.json with a placeholder left in it refuses to build', t => {
  assert.throws(() => readTarget(configFile(t, { ...live, workosClientId: 'PLACEHOLDER: staging client id' }), { build: true }), /placeholder.*workosClientId/i);
  assert.equal(readTarget(configFile(t, { ...live, workosClientId: 'PLACEHOLDER: staging client id' })).deployment, 'nautical-viper-899', 'backups only need the deployment');
  assert.equal(readTarget(configFile(t, live), { build: true }).deployment, 'nautical-viper-899');
});

test('the target must be a Convex cloud URL and a well-formed WorkOS client', t => {
  assert.throws(() => readTarget(configFile(t, { ...live, convexUrl: 'http://127.0.0.1:3210' })), /convexUrl/);
  assert.throws(() => readTarget(configFile(t, { ...live, workosClientId: 'pk_live_123' }), { build: true }), /workosClientId/);
  assert.throws(() => readTarget(configFile(t, { ...live, authSessionMode: 'anything' }), { build: true }), /authSessionMode/);
});

test('only a production deploy key for the target deployment is accepted', () => {
  assert.throws(() => requireDeployKey(undefined, 'nautical-viper-899'), /CONVEX_DEPLOY_KEY/);
  assert.throws(() => requireDeployKey('prod:gallant-pika-581|secret', 'nautical-viper-899'), /gallant-pika-581/);
  assert.throws(() => requireDeployKey('dev:nautical-viper-899|secret', 'nautical-viper-899'), /prod:nautical-viper-899/);
  assert.throws(() => requireDeployKey('project:team:remold|secret', 'nautical-viper-899'), /prod:nautical-viper-899/);
  requireDeployKey('prod:nautical-viper-899|secret', 'nautical-viper-899');
});

test('a dirty tree, a detached HEAD or a commit missing from origin is refused', t => {
  const { work, commit } = repo(t), first = commit('a');
  assert.throws(() => releasable(work), /not on origin/);
  git(work, 'push', '-q', 'origin', 'main');
  assert.equal(releasable(work), first);
  writeFileSync(join(work, 'stray'), 'x');
  assert.throws(() => releasable(work), /uncommitted/);
  rmSync(join(work, 'stray'));
  git(work, 'checkout', '-q', '--detach');
  assert.throws(() => releasable(work), /detached/);
  assert.equal(releasable(work, first), first, 'an explicit ref may be deployed from any branch state');
  git(work, 'checkout', '-q', 'main'); commit('b');
  assert.throws(() => releasable(work), /not on origin/);
});

test('a commit whose only origin branch was deleted on origin is refused, even though a stale local ref still names it', t => {
  const { work, origin, commit } = repo(t);
  commit('a'); git(work, 'push', '-q', 'origin', 'main');
  git(work, 'checkout', '-q', '-b', 'release'); const release = commit('b'); git(work, 'push', '-q', 'origin', 'release');
  assert.equal(releasable(work), release);
  git(origin, 'branch', '-D', 'release');
  assert.ok(git(work, 'for-each-ref', 'refs/remotes/origin/release'), 'the local remote-tracking ref is still there');
  assert.throws(() => releasable(work), /not on origin/);
});

test('a rollback ref older than the pinned rollback target is refused', t => {
  const { work, commit } = repo(t), older = commit('a'), pinned = commit('b'), newer = commit('c');
  assert.throws(() => rollbackFloor(work, older, pinned), /older than the rollback target/);
  rollbackFloor(work, pinned, pinned); rollbackFloor(work, newer, pinned);
  git(work, 'checkout', '-q', '-b', 'side', older); const side = commit('d');
  assert.throws(() => rollbackFloor(work, side, pinned), /older than the rollback target/, 'a branch that never contained the target is refused too');
});

test('a bundle aimed at any deployment but the target is refused', t => {
  const dist = temp(t), target = readTarget(configFile(t, live), { build: true });
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<script src="/assets/index.js"></script>');
  writeFileSync(join(dist, 'assets/index.js'), 'new Client("https://gallant-pika-581.convex.cloud");"client_01TESTVALUE"');
  assert.throws(() => checkBundle(dist, target), /gallant-pika-581/);
  writeFileSync(join(dist, 'assets/index.js'), 'new Client("https://nautical-viper-899.convex.cloud");"client_01OTHER"');
  assert.throws(() => checkBundle(dist, target), /client_01TESTVALUE/);
  writeFileSync(join(dist, 'assets/index.js'), 'new Client("https://nautical-viper-899.convex.cloud");"client_01TESTVALUE";"requires a URL like \'https://happy-otter-123.convex.cloud\'"');
  checkBundle(dist, target);
});

test('deploy pushes Convex functions before the frontend that calls them', () => {
  assert.deepEqual(deployCommands().map(command => command.slice(0, 4).join(' ')), ['pnpm exec convex deploy', 'pnpm dlx wrangler@4.138.0 deploy']);
});
