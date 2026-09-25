import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, lstatSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { restoreDrill, canonical } from './snapshot.mjs';

const manifestName = 'release-manifest.json';
export const digest = value => createHash('sha256').update(value).digest('hex');
function requireSha(value) {
  if (!/^[a-f0-9]{40}$/.test(value ?? '')) throw new Error('A full Git commit SHA is required');
}
function inventory(directory, prefix = '') {
  const entries = [];
  for (const name of readdirSync(join(directory, prefix)).sort()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (path === manifestName) continue;
    const stat = lstatSync(join(directory, path));
    if (stat.isSymbolicLink()) throw new Error('Artifact contains a symlink');
    if (stat.isDirectory()) entries.push(...inventory(directory, path));
    else if (stat.isFile()) entries.push({ path, sha256: digest(readFileSync(join(directory, path))) });
    else throw new Error('Artifact contains a non-regular file');
  }
  return entries;
}
export function sealArtifact(directory, metadata) {
  requireSha(metadata.sha);
  const version = JSON.parse(readFileSync(join(directory, 'version.json'), 'utf8'));
  if (version.sha !== metadata.sha) throw new Error('Artifact version does not match commit');
  if (!existsSync(join(directory, 'index.html'))) throw new Error('Missing frontend index');
  const manifest = JSON.stringify({ ...metadata, format: 1, files: inventory(directory) }, null, 2) + '\n';
  writeFileSync(join(directory, manifestName), manifest, { flag: 'wx' });
  return digest(manifest);
}
export function verifyArtifact(directory, expectedSha, expectedManifestDigest) {
  requireSha(expectedSha);
  if (!/^[a-f0-9]{64}$/.test(expectedManifestDigest ?? '')) throw new Error('A pinned manifest digest is required');
  const bytes = readFileSync(join(directory, manifestName));
  if (digest(bytes) !== expectedManifestDigest) throw new Error('Release manifest digest mismatch');
  const manifest = JSON.parse(bytes);
  if (manifest.format !== 1 || manifest.sha !== expectedSha) throw new Error('Release commit mismatch');
  if (JSON.stringify(manifest.files) !== JSON.stringify(inventory(directory))) throw new Error('Artifact inventory mismatch');
  if (JSON.parse(readFileSync(join(directory, 'version.json'), 'utf8')).sha !== expectedSha) throw new Error('Release version mismatch');
  return manifest;
}
export function runChecks(commands, cwd) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'CI', 'PNPM_HOME']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.VITE_CONVEX_URL = 'https://release-fixture.invalid';
  env.VITE_WORKOS_CLIENT_ID = 'client_releasefixture';
  for (const [command, ...args] of commands) {
    const result = spawnSync(command, args, { cwd, stdio: 'inherit', env });
    if (result.error || result.status !== 0) throw new Error(`Verification failed: ${command} ${args.join(' ')}`);
  }
}
export function validateReleaseNotes(notes, changedFiles) {
  if (!['ui-only', 'expand', 'migrate'].includes(notes.class)) throw new Error('Release class must be ui-only, expand or migrate; destructive contraction is unsupported');
  requireSha(notes.rollbackTarget);
  // Source code is conservative: a TSX edit can change writes as well as appearance.
  const cosmetic = path => /^(docs\/|reference\/)/.test(path) || /\.(css|png|jpe?g|svg|webp|ico)$/.test(path);
  if (notes.class === 'ui-only' && changedFiles.some(path => !cosmetic(path))) throw new Error('Potentially persisted behavior cannot use a UI-only snapshot exemption');
  return { class: notes.class, rollbackTarget: notes.rollbackTarget };
}
const appDocuments = canonical => Object.values(canonical?.tables ?? {}).reduce((sum, table) => sum + table.count, 0);
export function preflight(manifest, targetSha, targetSchemaDigest, snapshotReceipt, manifestSha256, expectedBackup) {
  requireSha(targetSha);
  if (targetSha !== manifest.release.rollbackTarget) throw new Error('Rollback target is not the declared compatible commit');
  if (targetSchemaDigest !== manifest.schemaSha256) throw new Error('Rollback schema differs; destructive or earlier schema rollback is unsupported');
  if (manifest.release.class !== 'ui-only') {
    if (!snapshotReceipt) throw new Error('Blocked: actual restored-snapshot validation and independent evidence integration are not available');
    if (snapshotReceipt.result !== 'PASS') throw new Error('Snapshot receipt did not pass restored-snapshot validation');
    if (snapshotReceipt.releaseSha !== manifest.sha) throw new Error('Snapshot receipt release SHA does not match artifact');
    if (snapshotReceipt.candidateSchemaSha256 !== manifest.schemaSha256) throw new Error('Snapshot receipt schema digest does not match artifact');
    if (!/^[a-f0-9]{64}$/.test(manifestSha256 ?? '')) throw new Error('Snapshot receipt requires the pinned manifest digest');
    if (snapshotReceipt.manifestSha256 !== manifestSha256) throw new Error('Snapshot receipt manifest digest does not match pinned artifact');
    if (!/^[a-f0-9]{64}$/.test(snapshotReceipt.snapshotSha256 ?? '')) throw new Error('Snapshot receipt has no valid snapshot SHA256');
    if (!/^[a-f0-9]{64}$/.test(expectedBackup?.snapshotSha256 ?? '') || !expectedBackup.canonical) throw new Error('Persisted preflight requires the expected backup');
    if (appDocuments(expectedBackup.canonical) > 0 && appDocuments(snapshotReceipt.canonical) === 0) throw new Error('Snapshot receipt restored empty app tables but the expected backup has data');
    if (snapshotReceipt.snapshotSha256 !== expectedBackup.snapshotSha256) throw new Error('Snapshot receipt is not for the expected backup');
    return { snapshot: 'restored-and-validated', snapshotSha256: snapshotReceipt.snapshotSha256, deploymentAuthorized: false };
  }
  return { snapshot: 'not-required', deploymentAuthorized: false };
}
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
export function resolveBase(cwd, headSha, baseSha, event) {
  requireSha(headSha); requireSha(baseSha);
  if (event === 'pull_request') {
    const bases = git(cwd, 'merge-base', '--all', baseSha, headSha).split('\n');
    if (bases.length !== 1) throw new Error('PR diff requires one unambiguous common ancestor');
    return bases[0];
  }
  if (event !== 'push') throw new Error('Unsupported release event');
  git(cwd, 'merge-base', '--is-ancestor', baseSha, headSha);
  return baseSha;
}
function assertClean(cwd, sha) {
  if (git(cwd, 'rev-parse', 'HEAD') !== sha) throw new Error('Checkout does not match expected commit');
  if (git(cwd, 'status', '--porcelain', '--untracked-files=all')) throw new Error('Release requires a clean checkout');
}
export function build(cwd, output, sha, baseSha, notesPath) {
  requireSha(sha); requireSha(baseSha);
  assertClean(cwd, sha);
  if (readdirSync(cwd).some(name => name.startsWith('.env') && name !== '.env.example')) throw new Error('Release verification requires a checkout without local environment files');
  git(cwd, 'merge-base', '--is-ancestor', baseSha, sha);
  const release = validateReleaseNotes(JSON.parse(readFileSync(notesPath, 'utf8')), git(cwd, 'diff', '--name-only', baseSha, sha).split('\n').filter(Boolean));
  git(cwd, 'cat-file', '-e', `${release.rollbackTarget}^{commit}`);
  output = resolve(output);
  // A new external directory avoids touching tracked dist or collecting existing private files.
  if (existsSync(output)) throw new Error('Output directory must not exist');
  const parent = realpathSync(resolve(output, '..'));
  const within = relative(realpathSync(cwd), parent);
  if (within === '' || (!within.startsWith('..') && !isAbsolute(within))) throw new Error('Output must be outside the repository');
  const checks = [
    ['pnpm', 'test'],
    ['pnpm', 'typecheck'],
    ['node', '--test', 'ops/release/release.test.mjs'],
    ['pnpm', '--dir', 'packages/mcp', 'test'],
    ['pnpm', '--dir', 'packages/mcp', 'build'],
    ['pnpm', 'exec', 'vite', 'build', '--outDir', output],
  ];
  runChecks(checks, cwd);
  assertClean(cwd, sha);
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'version.json'), JSON.stringify({ sha }) + '\n', { flag: 'wx' });
  const pin = sealArtifact(output, {
    sha, baseSha, release,
    schemaSha256: digest(readFileSync(join(cwd, 'convex/schema.ts'))),
    checks: checks.map(command => command.join(' ')),
  });
  verifyArtifact(output, sha, pin);
  return { sha, manifestSha256: pin, output, deploymentAuthorized: false };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const [command, directory, sha, third, notes, snapshot, receiptOut] = process.argv.slice(2);
    if (command === 'base') console.log(resolveBase(process.cwd(), directory, sha, third));
    else if (command === 'build') console.log(JSON.stringify(build(process.cwd(), directory, sha, third, notes)));
    else if (command === 'verify') console.log(JSON.stringify({ sha: verifyArtifact(directory, sha, third).sha, deploymentAuthorized: false }));
    else if (command === 'preflight') {
      const manifest = verifyArtifact(directory, sha, third);
      const schema = execFileSync('git', ['show', `${manifest.release.rollbackTarget}:convex/schema.ts`]);
      const receipt = notes ? JSON.parse(readFileSync(notes, 'utf8')) : undefined;
      // The operator names the real backup file; its bytes, not the receipt, define the expected snapshot.
      const expected = snapshot ? { snapshotSha256: digest(readFileSync(snapshot)), canonical: canonical(snapshot) } : undefined;
      console.log(JSON.stringify(preflight(manifest, manifest.release.rollbackTarget, digest(schema), receipt, third, expected)));
    } else if (command === 'snapshot') {
      const manifest = verifyArtifact(directory, sha, third);
      assertClean(notes, sha);
      if (digest(readFileSync(join(notes, 'convex/schema.ts'))) !== manifest.schemaSha256) throw new Error('Checkout schema does not match artifact');
      const drill = await restoreDrill({ source: notes, snapshot });
      const receipt = { releaseSha: sha, manifestSha256: third, snapshotSha256: drill.snapshotSha256, candidateSchemaSha256: drill.candidateSchemaSha256, result: drill.result, ...(drill.reason ? { reason: drill.reason } : {}), canonical: drill.canonical, at: new Date().toISOString() };
      writeFileSync(receiptOut, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify(receipt)); if (drill.result !== 'PASS') process.exitCode = 1;
    } else throw new Error('Usage: release.mjs base <head-sha> <base-sha> <pull_request|push> | build <new-external-output> <sha> <base-sha> <notes.json> | verify|preflight <artifact> <sha> <pinned-manifest-sha256> [receipt.json expected-backup.zip] | snapshot <artifact> <sha> <pinned-manifest-sha256> <checkout-dir> <snapshot.zip> <receipt-out.json>');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
