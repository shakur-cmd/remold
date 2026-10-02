// pnpm backup:drill <backup.zip>: restores a backup into a throwaway loopback Convex backend,
// re-exports it and compares row counts table by table. Exits non-zero on any difference.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { local } from '../release/snapshot.mjs';
import { sha256 } from './export.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (zip, file) => execFileSync('unzip', ['-p', zip, file], { encoding: 'utf8', maxBuffer: 1 << 30 }).split('\n').filter(Boolean);

// The zip carries no row counts of its own, so a doctored copy restores faithfully; the export-time checksum is the anchor.
export function recorded(zip) {
  const sums = join(dirname(zip), 'SHA256SUMS'), name = basename(zip);
  const line = existsSync(sums) && readFileSync(sums, 'utf8').split('\n').findLast(entry => entry.endsWith(`  ${name}`));
  if (!line) return `${name} is not listed in SHA256SUMS next to it`;
  return line.split('  ')[0] === sha256(zip) || `${name} does not match SHA256SUMS; it changed after export`;
}

// Counts rows per table, components included; `missing` lists tables an index names but the zip lacks.
export function zipCounts(zip) {
  const files = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).split('\n').filter(Boolean), counts = {}, missing = [];
  for (const file of files) { const table = /^(.+)\/documents\.jsonl$/.exec(file)?.[1]; if (table) counts[table] = read(zip, file).length; }
  for (const index of files.filter(file => /(^|\/)_tables\/documents\.jsonl$/.test(file))) {
    const prefix = index.slice(0, -'_tables/documents.jsonl'.length);
    for (const { name } of read(zip, index).map(JSON.parse)) if (!files.includes(`${prefix}${name}/documents.jsonl`)) missing.push(prefix + name);
  }
  return { counts: Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))), missing };
}

export function compareCounts(backup, restored) {
  const problems = [];
  for (const [table, rows] of Object.entries(backup)) {
    if (!(table in restored)) problems.push(`${table}: missing after restore (backup has ${rows} rows)`);
    else if (restored[table] !== rows) problems.push(`${table}: backup has ${rows} rows, restore has ${restored[table]}`);
  }
  for (const [table, rows] of Object.entries(restored)) if (!(table in backup) && rows) problems.push(`${table}: not in backup, restore has ${rows} rows`);
  return problems;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const zip = resolve(process.argv[2] ?? ''), report = { zip, result: 'FAIL', problems: [] };
  try {
    if (!process.argv[2] || !existsSync(zip)) throw new Error('Usage: pnpm backup:drill <backup.zip>');
    report.sha256 = sha256(zip);
    const trusted = recorded(zip);
    if (trusted !== true) report.problems.push(trusted);
    const { counts, missing } = zipCounts(zip);
    report.problems.push(...missing.map(table => `${table}: named in the backup's table index but has no rows file`));
    // Loopback only: local() refuses a non-127.0.0.1 backend and never sees a deploy key.
    const restored = await local(root, 'remold-restore-drill-', [3492, 3493], true, async backend => {
      backend.run('import', '--replace-all', '-y', zip);
      const out = join(backend.scratch, 'restored.zip'); backend.run('export', '--path', out);
      return zipCounts(out).counts;
    });
    report.problems.push(...compareCounts(counts, restored));
    Object.assign(report, { tables: Object.keys(counts).length, rows: Object.values(counts).reduce((a, b) => a + b, 0), restoredRows: Object.values(restored).reduce((a, b) => a + b, 0) });
    if (!report.problems.length) report.result = 'PASS';
  } catch (error) { report.problems.push(String(error.message).slice(0, 500)); }
  console.log(JSON.stringify(report, null, 2));
  if (report.result !== 'PASS') process.exitCode = 1;
}
