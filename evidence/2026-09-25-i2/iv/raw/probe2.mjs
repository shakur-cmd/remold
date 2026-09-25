// Re-run tamper/empty probes with zip -D (no directory entries) so only document content differs.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = process.cwd();
const { restoreDrill, seedSnapshot, canonical } = await import(join(root, 'ops/release/snapshot.mjs'));
const temp = mkdtempSync(join(tmpdir(), 'i2iv-probe2-'));
const snap = join(temp, 'fixture.zip'); await seedSnapshot({ source: root, out: snap, ports: [3480, 3481] });
const rezip = (name, edit) => { const d = join(temp, name); execFileSync('unzip', ['-q', snap, '-d', d]); edit(d); const z = join(temp, name + '.zip'); execFileSync('zip', ['-qrD', z, '.'], { cwd: d }); return z; };
const out = {};
out.rezipUnchanged = await restoreDrill({ source: root, snapshot: rezip('same', () => {}), ports: [3482, 3483] });
out.tamperedTitle = await restoreDrill({ source: root, snapshot: rezip('tam', d => { const f = join(d, 'records/documents.jsonl'); writeFileSync(f, readFileSync(f, 'utf8').replace('"title":"', '"title":"Tampered ')); }), ports: [3484, 3485] });
out.invalidDoc = await restoreDrill({ source: root, snapshot: rezip('inv', d => { const f = join(d, 'records/documents.jsonl'); writeFileSync(f, readFileSync(f, 'utf8').replace(/"title":"[^"]*"/, '"title":12345')); }), ports: [3486, 3487] });
out.emptiedAppTables = await restoreDrill({ source: root, snapshot: rezip('empty', d => { for (const t of readdirSync(d)) { const f = join(d, t, 'documents.jsonl'); if (!t.startsWith('_') && statSync(join(d, t)).isDirectory()) try { writeFileSync(f, ''); } catch {} } }), ports: [3488, 3489] });
for (const k of Object.keys(out)) out[k] = { result: out[k].result, reason: out[k].reason?.slice(0, 300), snapshotSha256: out[k].snapshotSha256, records: out[k].canonical.tables.records, users: out[k].canonical.tables.users };
out.originalSnapshotSha256 = (await import('node:crypto')).createHash('sha256').update(readFileSync(snap)).digest('hex');
writeFileSync(process.argv[2], JSON.stringify(out, null, 2)); console.log(JSON.stringify(out, null, 1));
