import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { preflight, digest } = await import(process.argv[2]);
const { canonical } = await import(process.argv[3]);
const dir = mkdtempSync(join(tmpdir(), 'remold-backup-probe-'));
const zip = (name, tables) => { const tree = join(dir, name); for (const [t, docs] of Object.entries(tables)) { mkdirSync(join(tree, t), { recursive: true }); writeFileSync(join(tree, t, 'documents.jsonl'), docs.map(JSON.stringify).join('\n') + (docs.length ? '\n' : '')); } execFileSync('zip', ['-qrD', `${name}.zip`, ...Object.keys(tables)], { cwd: tree }); return join(tree, `${name}.zip`); };
const users = [{ _id: 'users:1', name: 'Fixture' }], records = [{ _id: 'records:1', title: 'Original' }, { _id: 'records:2', title: 'Second' }];
const rec = p => ({ snapshotSha256: digest(readFileSync(p)), canonical: canonical(p) });
const expected = rec(zip('backup', { users, records }));
const sha = 'a'.repeat(40), rollback = 'b'.repeat(40), schema = 'c'.repeat(64), pin = digest('pin');
const manifest = { sha, schemaSha256: schema, release: { class: 'expand', rollbackTarget: rollback } };
const receipt = s => ({ result: 'PASS', releaseSha: sha, manifestSha256: pin, candidateSchemaSha256: schema, ...s });
const cases = { emptiedSnapshot: rec(zip('emptied', { users: [], records: [] })), schemaValidEditedSnapshot: rec(zip('edited', { users, records: [{ ...records[0], title: 'Edited' }, records[1]] })), random64Hex: { ...expected, snapshotSha256: 'e'.repeat(64) }, genuine: expected };
for (const [name, s] of Object.entries(cases)) { try { preflight(manifest, rollback, schema, receipt(s), pin, expected); console.log(`${name}: ACCEPTED`); } catch (e) { console.log(`${name}: REFUSED (${e.message})`); } }
