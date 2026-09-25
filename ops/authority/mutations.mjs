import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = process.cwd(), scratch = mkdtempSync(join(tmpdir(), 'remold-authority-mutations-'));
for (const path of ['convex', 'packages/contracts', 'ops/authority']) cpSync(join(root, path), join(scratch, path), { recursive: true, filter: p => !p.includes('/evidence') });
cpSync(join(root, 'package.json'), join(scratch, 'package.json')); symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const controls = [
  { name: 'hidden-field-deny', file: 'convex/authority/reads.ts', from: '!hidden?.includes(field._id) && ', to: '', test: 'ops/authority/masks.test.ts' },
  { name: 'object-scope-boundary', file: 'convex/authority/reads.ts', from: "g.scope.objectId === object._id).flatMap", to: "true).flatMap", test: 'ops/authority/grants.test.ts' },
  { name: 'durable-cancel-check', file: 'convex/integrations/commands.ts', from: 'cancelRequestedAt: Date.now()', to: 'cancelRequestedAt: undefined', test: 'ops/authority/operations.test.ts' },
  { name: 'code-owned-finality-verifier', file: 'convex/integrations/safetyFinality.ts', from: '!await selected.verifyAbsent(ctx, checked.request, checked.proof)', to: 'false', test: 'ops/authority/safety.test.ts' },
  { name: 'explicit-inbox-audience', file: 'convex/authority/inbox.ts', from: "return audience === 'org' && sharedInboxReader(principal);", to: 'return true;', test: 'ops/authority/inbox.test.ts' },
];
const results = [];
for (const c of controls) {
  const file = join(scratch, c.file), original = readFileSync(file, 'utf8'); assert.equal(original.split(c.from).length, 2, c.name + ' unique mutation seam');
  const mutant = original.replace(c.from, c.to); writeFileSync(file, mutant);
  let output = '', code = 0;
  try { output = execFileSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'ops/authority/vitest.config.ts', c.test], { cwd: scratch, env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CI: '1' }, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { code = error.status; output = String(error.stdout ?? '') + String(error.stderr ?? ''); }
  finally { writeFileSync(file, original); }
  writeFileSync(join(root, 'ops/authority/evidence/mutant-' + c.name + '.log'), output);
  const caught = code !== 0 && /AssertionError/.test(output);
  results.push({ name: c.name, file: c.file, test: c.test, originalSha256: sha(original), mutantSha256: sha(mutant), exitCode: code, caught });
  console.log(caught ? 'CAUGHT' : 'NOT CAUGHT', c.name);
}
writeFileSync(join(root, 'ops/authority/evidence/mutations.json'), JSON.stringify({ scratch, level: 'SIM convex-test, copied source only', results }, null, 2) + '\n');
assert.ok(results.every(r => r.caught), 'Every selected semantic regression must fail a behavior assertion');
