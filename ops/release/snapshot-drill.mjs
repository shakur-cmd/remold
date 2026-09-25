import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { canonical, restoreDrill, seedSnapshot } from './snapshot.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [output, flag, provided] = process.argv.slice(2);
if (!output || (flag && (flag !== '--snapshot' || !provided))) throw new Error('Usage: snapshot-drill.mjs <evidence.json> [--snapshot <snapshot.zip>]');
const temp = mkdtempSync(join(tmpdir(), 'remold-snapshot-drill-'));
const results = {}, evidence = { level: flag ? 'SANDBOX snapshot restored into local scratch' : 'SERVICE-local; synthetic fixture', sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()), results, limitations: ['Loopback local Convex only; no cloud deployment or customer data', 'Synthetic fixture does not prove a managed backup export or independent verification'] };
function candidate(name, change) {
  const source = join(temp, name); cpSync(join(root, 'convex'), join(source, 'convex'), { recursive: true });
  const schema = join(source, 'convex/schema.ts'), before = readFileSync(schema, 'utf8'), after = change(before);
  assert.notEqual(after, before, `Expected ${name} schema replacement`); writeFileSync(schema, after); return source;
}
try {
  const snapshot = flag ? resolve(provided) : join(temp, 'fixture.zip');
  if (!flag) results.seed = await seedSnapshot({ source: root, out: snapshot });
  results.green = await restoreDrill({ source: root, snapshot, ports: [3470, 3471] });
  assert.equal(results.green.result, 'PASS', results.green.reason);
  const red = candidate('red', text => text.replace('users: defineTable({ tokenIdentifier: v.string(),', 'users: defineTable({ tokenIdentifier: v.string(), requiredAfterRestore: v.string(),'));
  results.red = await restoreDrill({ source: red, snapshot, ports: [3472, 3473] });
  assert.equal(results.red.result, 'FAIL', 'Incompatible schema unexpectedly accepted');
  assert.match(results.red.reason ?? '', /Schema validation failed|Failed to|does not match the schema/i, results.red.reason);
  const expansion = candidate('expansion', text => text.replace('users: defineTable({ tokenIdentifier: v.string(),', 'users: defineTable({ tokenIdentifier: v.string(), requiredAfterRestore: v.optional(v.string()),'));
  results.expansion = await restoreDrill({ source: expansion, snapshot, ports: [3474, 3475] });
  assert.equal(results.expansion.result, 'PASS', results.expansion.reason);
  const unpacked = join(temp, 'tampered'); execFileSync('unzip', ['-q', snapshot, '-d', unpacked]);
  const records = join(unpacked, 'records/documents.jsonl'), original = readFileSync(records, 'utf8');
  writeFileSync(records, original.replace('"title":"', '"title":"Tampered '));
  assert.notEqual(readFileSync(records, 'utf8'), original, 'Tamper needs at least one record title');
  const tampered = join(temp, 'tampered.zip'); execFileSync('zip', ['-qr', tampered, '.'], { cwd: unpacked });
  results.tamper = { originalSha256: canonical(snapshot).sha256, tamperedSha256: canonical(tampered).sha256 };
  assert.notEqual(results.tamper.originalSha256, results.tamper.tamperedSha256, 'Tampering did not change canonical data');
} catch (error) { evidence.error = error.message; process.exitCode = 1; }
finally { writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n'); console.log(JSON.stringify({ result: process.exitCode ? 'FAIL' : 'PASS', output, results })); }
