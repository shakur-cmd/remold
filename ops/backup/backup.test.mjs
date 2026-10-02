import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportBackup } from './export.mjs';
import { compareCounts, recorded, zipCounts } from './restore-drill.mjs';

const temp = t => { const dir = mkdtempSync(join(tmpdir(), 'remold-backup-test-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const key = 'prod:nautical-viper-899|secret';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// A copy of the scripts whose convex CLI, like the real one, resolves --path against its own working directory.
function exportFixture(t) {
  const dir = temp(t);
  for (const file of ['ops/backup/export.mjs', 'ops/deploy/prod.mjs', 'ops/deploy/prod.json', 'ops/release/release.mjs', 'ops/release/snapshot.mjs']) cpSync(join(root, file), join(dir, file));
  mkdirSync(join(dir, 'node_modules/convex/bin'), { recursive: true });
  writeFileSync(join(dir, 'node_modules/convex/bin/main.js'), `const fs = require('node:fs'), args = process.argv.slice(2);
if (args[0] !== 'export' || !process.env.CONVEX_DEPLOY_KEY) process.exit(2);
fs.writeFileSync(args[args.indexOf('--path') + 1], 'exported from ' + process.cwd());`);
  writeFileSync(join(dir, 'node_modules/convex/package.json'), '{"type":"commonjs"}');
  return dir;
}
const fakeExport = path => writeFileSync(path, 'zip bytes ' + path);
function zipOf(t, tables) {
  const dir = temp(t), out = join(dir, 'export.zip'), src = join(dir, 'src');
  for (const [path, rows] of Object.entries(tables)) { mkdirSync(join(src, path, '..'), { recursive: true }); writeFileSync(join(src, path), rows.map(row => JSON.stringify(row) + '\n').join('')); }
  execFileSync('zip', ['-qr', out, '.'], { cwd: src });
  return out;
}

test('a backup lands in the folder with a UTC-stamped name and a checksum line, deleting nothing', async t => {
  const dir = temp(t);
  writeFileSync(join(dir, 'SHA256SUMS'), 'earlier  old.zip\n'); writeFileSync(join(dir, 'old.zip'), 'old');
  const first = await exportBackup({ dir, deployment: 'nautical-viper-899', key, now: new Date('2026-10-01T23:05:09.123Z'), exportZip: fakeExport });
  assert.equal(first, join(dir, 'nautical-viper-899-20261001T230509Z.zip'));
  const second = await exportBackup({ dir, deployment: 'nautical-viper-899', key, now: new Date('2026-10-02T06:00:00Z'), exportZip: fakeExport });
  assert.deepEqual(readFileSync(join(dir, 'SHA256SUMS'), 'utf8').split('\n'), ['earlier  old.zip', `${sha(first)}  nautical-viper-899-20261001T230509Z.zip`, `${sha(second)}  nautical-viper-899-20261002T060000Z.zip`, '']);
  assert.deepEqual(readdirSync(dir).sort(), ['SHA256SUMS', 'nautical-viper-899-20261001T230509Z.zip', 'nautical-viper-899-20261002T060000Z.zip', 'old.zip']);
  await assert.rejects(exportBackup({ dir, deployment: 'nautical-viper-899', key, now: new Date('2026-10-02T06:00:00Z'), exportZip: fakeExport }), /already exists/);
});

test('a relative REMOLD_BACKUP_DIR keeps the zip and its checksum where the caller meant', t => {
  const scripts = exportFixture(t), caller = temp(t);
  for (const backupDir of ['.', 'nested/backups']) {
    const result = spawnSync(process.execPath, [join(scripts, 'ops/backup/export.mjs')], { cwd: caller, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, CONVEX_DEPLOY_KEY: key, REMOLD_BACKUP_DIR: backupDir } });
    assert.equal(result.status, 0, result.stderr);
    const dir = join(caller, backupDir), zips = readdirSync(dir).filter(name => name.endsWith('.zip'));
    assert.equal(zips.length, 1, `one zip in ${backupDir}`);
    assert.equal(readFileSync(join(dir, 'SHA256SUMS'), 'utf8'), `${sha(join(dir, zips[0]))}  ${zips[0]}\n`);
    assert.ok(existsSync(join(dir, zips[0])));
  }
});

test('a backup refuses to run without a production key for the deployment', async t => {
  const dir = temp(t); let ran = false;
  await assert.rejects(exportBackup({ dir, deployment: 'nautical-viper-899', key: 'prod:gallant-pika-581|secret', now: new Date(), exportZip: () => { ran = true; } }), /gallant-pika-581/);
  await assert.rejects(exportBackup({ dir, deployment: 'nautical-viper-899', key: undefined, now: new Date(), exportZip: () => { ran = true; } }), /CONVEX_DEPLOY_KEY/);
  assert.equal(ran, false);
});

test('the drill only trusts a zip whose checksum the export recorded', async t => {
  const dir = temp(t);
  const zip = await exportBackup({ dir, deployment: 'nautical-viper-899', key, now: new Date('2026-10-01T00:00:00Z'), exportZip: fakeExport });
  assert.equal(recorded(zip), true);
  writeFileSync(zip, 'zip bytes with rows dropped');
  assert.match(recorded(zip), /does not match SHA256SUMS/);
  const stray = join(dir, 'copy.zip'); writeFileSync(stray, 'x');
  assert.match(recorded(stray), /not listed in SHA256SUMS/);
});

test('row counts cover app and component tables, and a table the index names but the zip lacks is reported', t => {
  const zip = zipOf(t, { '_tables/documents.jsonl': [{ name: 'users' }, { name: 'records' }, { name: 'events' }], 'users/documents.jsonl': [{ _id: 'u1' }], 'records/documents.jsonl': [{ _id: 'r1' }, { _id: 'r2' }], '_components/rateLimiter/_tables/documents.jsonl': [{ name: 'rateLimits' }], '_components/rateLimiter/rateLimits/documents.jsonl': [{ _id: 'l1' }] });
  const { counts, missing } = zipCounts(zip);
  assert.deepEqual(counts, { '_components/rateLimiter/_tables': 1, '_components/rateLimiter/rateLimits': 1, _tables: 3, records: 2, users: 1 });
  assert.deepEqual(missing, ['events']);
});

test('any table whose restored count differs, or that did not come back, fails the comparison', () => {
  assert.deepEqual(compareCounts({ users: 1, records: 250 }, { users: 1, records: 250 }), []);
  assert.deepEqual(compareCounts({ users: 1, records: 250 }, { users: 1, records: 249 }), ['records: backup has 250 rows, restore has 249']);
  assert.deepEqual(compareCounts({ users: 1, records: 250 }, { users: 1 }), ['records: missing after restore (backup has 250 rows)']);
  assert.deepEqual(compareCounts({ users: 1 }, { users: 1, ghosts: 2 }), ['ghosts: not in backup, restore has 2 rows']);
  assert.deepEqual(compareCounts({ users: 1 }, { users: 1, empty: 0 }), [], 'an empty table the fresh backend creates is not a difference');
});
