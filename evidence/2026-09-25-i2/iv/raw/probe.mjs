// Independent-verifier probes against restoreDrill. Run from the IV checkout root.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = process.cwd();
const { restoreDrill, canonical, seedSnapshot } = await import(join(root, 'ops/release/snapshot.mjs'));
const temp = mkdtempSync(join(tmpdir(), 'i2iv-probe-'));
const out = {};
const cand = (name, from, to) => { const s = join(temp, name); cpSync(join(root, 'convex'), join(s, 'convex'), { recursive: true }); const f = join(s, 'convex/schema.ts'); const t = readFileSync(f, 'utf8'); if (!t.includes(from)) throw new Error('no match ' + name); writeFileSync(f, t.replace(from, to)); return s; };
const snap = join(temp, 'fixture.zip');
out.seed = (await seedSnapshot({ source: root, out: snap, ports: [3480, 3481] })).canonical.tables.records;
// 1. type change on an existing required field must be refused
out.typeChange = await restoreDrill({ source: cand('type', 'title: v.string(), ref:', 'title: v.number(), ref:'), snapshot: snap, ports: [3482, 3483] });
// 2. removing a field that existing docs carry must be refused
out.removeField = await restoreDrill({ source: cand('remove', 'users: defineTable({ tokenIdentifier: v.string(), name: v.string(),', 'users: defineTable({ tokenIdentifier: v.string(),'), snapshot: snap, ports: [3484, 3485] });
// 3. tampered snapshot through the drill: is it refused, or does it PASS with a new hash?
const un = join(temp, 'tam'); execFileSync('unzip', ['-q', snap, '-d', un]);
const rec = join(un, 'records/documents.jsonl'); writeFileSync(rec, readFileSync(rec, 'utf8').replace('"title":"', '"title":"Tampered '));
const tam = join(temp, 'tampered.zip'); execFileSync('zip', ['-qr', tam, '.'], { cwd: un });
out.tamperedDrill = await restoreDrill({ source: root, snapshot: tam, ports: [3486, 3487] });
// 4. tampered snapshot that breaks the schema (title becomes a number) must be refused
const un2 = join(temp, 'tam2'); execFileSync('unzip', ['-q', snap, '-d', un2]);
const rec2 = join(un2, 'records/documents.jsonl'); writeFileSync(rec2, readFileSync(rec2, 'utf8').replace(/"title":"[^"]*"/, '"title":12345'));
const tam2 = join(temp, 'tampered-invalid.zip'); execFileSync('zip', ['-qr', tam2, '.'], { cwd: un2 });
out.invalidDocDrill = await restoreDrill({ source: root, snapshot: tam2, ports: [3488, 3489] });
// 5. an empty snapshot: does the gate accept a receipt produced from no data?
const un3 = join(temp, 'empty'); mkdirSync(join(un3, 'records'), { recursive: true }); writeFileSync(join(un3, 'records/documents.jsonl'), '');
const empty = join(temp, 'empty.zip'); execFileSync('zip', ['-qr', empty, '.'], { cwd: un3 });
out.emptyDrill = await restoreDrill({ source: root, snapshot: empty, ports: [3490, 3491] });
for (const k of Object.keys(out)) if (out[k]?.canonical) out[k] = { result: out[k].result, reason: out[k].reason, snapshotSha256: out[k].snapshotSha256, records: out[k].canonical.tables.records };
writeFileSync(process.argv[2], JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 1));
