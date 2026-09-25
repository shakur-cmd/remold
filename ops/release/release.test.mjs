import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, sealArtifact, verifyArtifact, runChecks, validateReleaseNotes, preflight, resolveBase } from './release.mjs';
import { canonical } from './snapshot.mjs';

const sha = 'a'.repeat(40);
const rollback = 'b'.repeat(40);
const schema = 'c'.repeat(64);
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'remold-release-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<main>Synthetic release fixture</main>');
  writeFileSync(join(dir, 'assets/app.js'), 'document.title = "Fixture";');
  writeFileSync(join(dir, 'version.json'), JSON.stringify({ sha }));
  return dir;
}
function seal(dir) {
  return sealArtifact(dir, { sha, baseSha: rollback, schemaSha256: schema, release: { class: 'ui-only', rollbackTarget: rollback }, checks: ['test'] });
}

test('unchanged release verifies only for its full commit and pinned manifest digest', t => {
  const dir = fixture(t), pin = seal(dir);
  assert.equal(verifyArtifact(dir, sha, pin).sha, sha);
  assert.throws(() => verifyArtifact(dir, rollback, pin), /commit/);
  assert.throws(() => verifyArtifact(dir, sha.slice(0, 7), pin), /full/);
});
test('changed, missing and injected artifact bytes are refused', t => {
  const dir = fixture(t), pin = seal(dir);
  writeFileSync(join(dir, 'assets/app.js'), 'tampered');
  assert.throws(() => verifyArtifact(dir, sha, pin), /inventory/);
  rmSync(join(dir, 'assets/app.js'));
  assert.throws(() => verifyArtifact(dir, sha, pin), /inventory/);
  writeFileSync(join(dir, 'private-export.json'), '{"customer":"must not ship"}');
  assert.throws(() => verifyArtifact(dir, sha, pin), /inventory/);
});
test('verification invoked through a symlink checks the artifact and refuses changed bytes', t => {
  const dir = fixture(t), pin = seal(dir);
  const alias = join(tmpdir(), `remold-release-alias-${process.pid}.mjs`);
  symlinkSync(fileURLToPath(new URL('./release.mjs', import.meta.url)), alias);
  t.after(() => rmSync(alias));
  const verify = () => spawnSync(process.execPath, [alias, 'verify', dir, sha, pin], { encoding: 'utf8' });
  const clean = verify();
  assert.equal(clean.status, 0);
  assert.match(clean.stdout, /"sha"/, 'CLI must execute verification rather than silently exit');
  assert.equal(JSON.parse(clean.stdout).sha, sha);
  writeFileSync(join(dir, 'assets/app.js'), 'changed after sealing');
  const changed = verify();
  assert.equal(changed.status, 1);
  assert.match(changed.stderr, /inventory mismatch/);
});
test('rewriting manifest checksums does not defeat the separately pinned digest', t => {
  const dir = fixture(t), pin = seal(dir);
  const manifest = JSON.parse(readFileSync(join(dir, 'release-manifest.json'), 'utf8'));
  manifest.checks = [];
  writeFileSync(join(dir, 'release-manifest.json'), JSON.stringify(manifest));
  assert.throws(() => verifyArtifact(dir, sha, pin), /manifest digest/);
});
test('version metadata must name the artifact commit', t => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'version.json'), JSON.stringify({ sha: rollback }));
  assert.throws(() => seal(dir), /version/);
});
test('symlink artifacts are refused instead of reading files outside the build', t => {
  const dir = fixture(t);
  symlinkSync(join(dir, 'index.html'), join(dir, 'assets/link'));
  assert.throws(() => seal(dir), /symlink/);
});
test('failed real process halts checks before a later process can run', t => {
  const dir = fixture(t), marker = join(dir, 'should-not-exist');
  assert.throws(() => runChecks([
    [process.execPath, '-e', 'process.exit(19)'],
    [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
  ], dir), /failed/);
  assert.equal(existsSync(marker), false);
});
test('successful real processes run in order', t => {
  const dir = fixture(t), marker = join(dir, 'order');
  runChecks([
    [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'first')`],
    [process.execPath, '-e', `if(require('node:fs').readFileSync(${JSON.stringify(marker)}, 'utf8') !== 'first') process.exit(1)`],
  ], dir);
});
test('persisted source cannot claim a UI-only snapshot exemption', () => {
  assert.throws(() => validateReleaseNotes({ class: 'ui-only', rollbackTarget: rollback }, ['convex/schema.ts']), /persisted/);
  assert.throws(() => validateReleaseNotes({ class: 'ui-only', rollbackTarget: rollback }, ['src/lib/client.ts']), /persisted/);
  assert.equal(validateReleaseNotes({ class: 'ui-only', rollbackTarget: rollback }, ['src/index.css']).class, 'ui-only');
});
test('missing metadata and destructive contraction are refused', () => {
  assert.throws(() => validateReleaseNotes({}, []), /class/);
  assert.throws(() => validateReleaseNotes({ class: 'contract', rollbackTarget: rollback }, []), /class/);
  assert.throws(() => validateReleaseNotes({ class: 'expand', rollbackTarget: 'main' }, []), /full/);
});
test('a rollback to a schema without the expanded fields is refused', () => {
  const manifest = { schemaSha256: schema, release: { class: 'migrate', rollbackTarget: rollback } };
  assert.throws(() => preflight(manifest, rollback, digest('old schema')), /schema/);
  assert.throws(() => preflight(manifest, sha, schema), /declared/);
});
test('persisted preflight requires a receipt bound to release, schema, and manifest', () => {
  const manifest = { sha, schemaSha256: schema, release: { class: 'expand', rollbackTarget: rollback } };
  const pin = digest('pinned manifest');
  const receipt = { result: 'PASS', releaseSha: sha, manifestSha256: pin, candidateSchemaSha256: schema, snapshotSha256: digest('snapshot') };
  assert.throws(() => preflight(manifest, rollback, schema, undefined, pin), /Blocked: actual restored-snapshot/);
  for (const changed of [{ releaseSha: rollback }, { candidateSchemaSha256: digest('other schema') }, { manifestSha256: digest('other manifest') }, { result: 'FAIL' }]) {
    assert.throws(() => preflight(manifest, rollback, schema, { ...receipt, ...changed }, pin), /[Ss]napshot receipt/);
  }
  assert.deepEqual(preflight(manifest, rollback, schema, receipt, pin), { snapshot: 'restored-and-validated', snapshotSha256: receipt.snapshotSha256, deploymentAuthorized: false });
});
test('UI-only artifacts can skip snapshot rehearsal without authorizing a deployment', () => {
  const manifest = { schemaSha256: schema, release: { class: 'ui-only', rollbackTarget: rollback } };
  assert.deepEqual(preflight(manifest, rollback, schema), { snapshot: 'not-required', deploymentAuthorized: false });
});

test('canonical snapshot data ignores JSONL order and catches changed documents', t => {
  const dir = mkdtempSync(join(tmpdir(), 'remold-snapshot-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const zip = (name, records) => {
    const tree = join(dir, name); mkdirSync(join(tree, 'records'), { recursive: true });
    writeFileSync(join(tree, 'records/documents.jsonl'), records.map(JSON.stringify).join('\n') + '\n');
    execFileSync('zip', ['-qr', `${name}.zip`, 'records'], { cwd: tree }); return join(tree, `${name}.zip`);
  };
  const one = zip('one', [{ _id: 'records:2', nested: { b: 2, a: 1 } }, { _id: 'records:1', title: 'same' }]);
  const two = zip('two', [{ _id: 'records:1', title: 'same' }, { nested: { a: 1, b: 2 }, _id: 'records:2' }]);
  const changed = zip('changed', [{ _id: 'records:1', title: 'different' }, { _id: 'records:2', nested: { a: 1, b: 2 } }]);
  assert.equal(canonical(one).sha256, canonical(two).sha256);
  assert.notEqual(canonical(one).tables.records.sha256, canonical(changed).tables.records.sha256);
});

test('verification subprocesses receive fixture config and cannot inherit provider secrets', t => {
  const dir = fixture(t);
  const previousUrl = process.env.VITE_CONVEX_URL, previousSecret = process.env.REMOLD_TEST_SECRET;
  process.env.VITE_CONVEX_URL = 'https://live-do-not-ship.invalid';
  process.env.REMOLD_TEST_SECRET = 'synthetic-secret';
  try {
    runChecks([[process.execPath, '-e', `
      if (process.env.REMOLD_TEST_SECRET) process.exit(11);
      if (process.env.VITE_CONVEX_URL !== 'https://release-fixture.invalid') process.exit(12);
    `]], dir);
  } finally {
    if (previousUrl === undefined) delete process.env.VITE_CONVEX_URL; else process.env.VITE_CONVEX_URL = previousUrl;
    if (previousSecret === undefined) delete process.env.REMOLD_TEST_SECRET; else process.env.REMOLD_TEST_SECRET = previousSecret;
  }
});

test('PR changes use their common ancestor when the target branch advances independently', t => {
  const dir = fixture(t);
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  git('config', 'core.hooksPath', join(dir, 'no-hooks'));
  git('config', 'user.name', 'Synthetic release test');
  git('config', 'user.email', 'fixture@example.invalid');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Common ancestor');
  const ancestor = git('rev-parse', 'HEAD');
  git('checkout', '-b', 'feature');
  writeFileSync(join(dir, 'theme.css'), 'body { color: blue; }');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Feature style');
  const head = git('rev-parse', 'HEAD');
  git('checkout', 'main');
  writeFileSync(join(dir, 'unrelated-backend.ts'), 'export const unrelated = true;');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Independent main change');
  const advancedBase = git('rev-parse', 'HEAD');
  const resolved = resolveBase(dir, head, advancedBase, 'pull_request');
  assert.equal(resolved, ancestor);
  assert.equal(git('diff', '--name-only', resolved, head), 'theme.css');
  assert.equal(resolveBase(dir, advancedBase, ancestor, 'push'), ancestor);
  assert.throws(() => resolveBase(dir, head, advancedBase, 'push'));
});
