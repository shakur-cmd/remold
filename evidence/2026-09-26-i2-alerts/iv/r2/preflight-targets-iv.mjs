// IV r2: preflight of the sealed b4dcdef artifact against several rollback targets.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const m = await import(process.cwd() + '/ops/release/release.mjs');
const OUT = '/tmp/iv2/release', SHA = 'b4dcdef7a5bb11115c32854b31ac73a2a5be1a21';
const pin = m.digest(readFileSync(`${OUT}/artifact/release-manifest.json`));
const manifest = m.verifyArtifact(`${OUT}/artifact`, SHA, pin);
const receipt = JSON.parse(readFileSync(`${OUT}/receipt.json`, 'utf8'));
const { canonical } = await import(process.cwd() + '/ops/release/snapshot.mjs').catch(() => ({}));
const backup = `${OUT}/synthetic-backup.zip`;
const expected = { snapshotSha256: m.digest(readFileSync(backup)), canonical: (m.canonical ?? canonical)(backup) };
console.log('declared target', manifest.release.rollbackTarget, 'class', manifest.release.class, 'artifact schema', manifest.schemaSha256);
for (const t of ['566abac6a382007d9d3edf58006904e1b2bc5e6f', 'bb8e3ed1a6df925e155c7eaeed4de5d9166fc14f', 'a173192ea40f90859917d418079a872b2950758d', 'd66eb0b1f8d5aac7aca63d9c964a6850f1e2584c', '069ce33']) {
  const full = execFileSync('git', ['rev-parse', t], { encoding: 'utf8' }).trim();
  const schema = m.digest(execFileSync('git', ['show', `${full}:convex/schema.ts`]));
  const man = { ...manifest, release: { ...manifest.release, rollbackTarget: full } };
  try { console.log(t.slice(0, 7), 'ACCEPTED', JSON.stringify(m.preflight(man, full, schema, receipt, pin, expected, m.authorityFloorCheck(process.cwd(), full)))); }
  catch (e) { console.log(t.slice(0, 7), 'refused:', e.message.slice(0, 160)); }
}
// Declared-target guard: the real manifest with a different target.
try { m.preflight(manifest, 'bb8e3ed1a6df925e155c7eaeed4de5d9166fc14f', m.digest(execFileSync('git', ['show', 'bb8e3ed:convex/schema.ts'])), receipt, pin, expected, true); console.log('undeclared target ACCEPTED'); } catch (e) { console.log('undeclared target refused:', e.message); }
