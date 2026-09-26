// Preflight the sealed b4dcdef artifact against three rollback targets.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const repo = process.argv[2];
const m = await import(repo + '/ops/release/release.mjs');
const { canonical } = await import(repo + '/ops/release/snapshot.mjs');
const pin = 'd0e0e644022a91fff199f4029e90d517af7006d1bed63eda33e02650e37a78db';
const manifest = m.verifyArtifact('/tmp/i2-release/artifact', 'b4dcdef7a5bb11115c32854b31ac73a2a5be1a21', pin);
const receipt = JSON.parse(readFileSync('/tmp/i2-release/receipt.json', 'utf8'));
const backup = '/tmp/i2-release/synthetic-backup.zip', expected = { snapshotSha256: m.digest(readFileSync(backup)), canonical: canonical(backup) };
const schemaAt = sha => m.digest(execFileSync('git', ['show', sha + ':convex/schema.ts'], { cwd: repo }));
for (const target of ['bb8e3ed1a6df925e155c7eaeed4de5d9166fc14f', 'a173192ea40f90859917d418079a872b2950758d', '566abac6a382007d9d3edf58006904e1b2bc5e6f']) {
  const floor = m.authorityFloorCheck(repo, target);
  try { console.log(target.slice(0, 7), 'accepted', JSON.stringify(m.preflight({ ...manifest, release: { ...manifest.release, rollbackTarget: target } }, target, schemaAt(target), receipt, pin, expected, floor))); }
  catch (e) { console.log(target.slice(0, 7), 'refused:', e.message); }
}
console.log('declared target', manifest.release.rollbackTarget, '| candidate schema', manifest.schemaSha256, '| 566abac schema', schemaAt('566abac'), '| bb8e3ed schema', schemaAt('bb8e3ed'));
