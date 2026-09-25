import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = process.cwd();
const evidenceDir = process.env.I1_EVIDENCE_DIR || join(root, 'ops/authority/evidence');
const sha = value => createHash('sha256').update(value).digest('hex');
const dirty = spawnSync('git', ['status', '--porcelain', 'convex'], { cwd: root, encoding: 'utf8' });
assert.equal(dirty.status, 0, dirty.stderr);
assert.equal(dirty.stdout, '', 'Refusing to mutate a worktree with existing convex changes');
mkdirSync(evidenceDir, { recursive: true });

const controls = [
  { name: 'instances', file: 'convex/integrations/connections.ts', from: 'binding.orgId !== connection.orgId || binding.connectionId !== connection._id || binding.provider !== connection.provider || binding.environment !== connection.environment || binding.account !== connection.account', to: 'binding.orgId !== connection.orgId', suites: 'instances', only: 'Same external ID' },
  { name: 'secret-format', file: 'convex/integrations/connections.ts', from: "if (!/^vault:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(args.handle)) fail('VALIDATION', 'Opaque vault reference required');", to: '', suites: 'secrets' },
  { name: 'secret-log', file: 'convex/integrations/connections.ts', from: "const ref = await ctx.db.get(args.secretReferenceId); if (!ref || ref.orgId !== args.orgId || !ref.active)", to: "const ref = await ctx.db.get(args.secretReferenceId); console.log('connect', ref?.handle); if (!ref || ref.orgId !== args.orgId || !ref.active)", suites: 'secrets' },
  { name: 'readonly-sweep', file: 'convex/agentApi.ts', from: 'const principal = await requireAgent(ctx, args.keyHash); await writable(ctx, principal.org._id); if (!args.text.trim())', to: 'const principal = await requireAgent(ctx, args.keyHash); if (!args.text.trim())', suites: 'sweeps' },
  { name: 'readonly-human', file: 'convex/orgs.ts', from: 'await requireWriter(ctx, args.orgId, "admin"); await ctx.db.patch(args.orgId, { name: args.name }', to: 'await requireMember(ctx, args.orgId, "admin"); await ctx.db.patch(args.orgId, { name: args.name }', suites: 'sweeps' },
  { name: 'wildcard-cutoff', file: 'convex/identity.ts', from: 'org.authorityFrozenAt !== undefined && object._creationTime <= org.authorityFrozenAt && agent.grants', to: 'org.authorityFrozenAt !== undefined && agent.grants', script: 'ops/authority/migration-service.mjs' },
  { name: 'mask-sweep', file: 'convex/authority/reads.ts', from: '!hidden?.includes(field._id) && ', to: '', suites: 'sweeps' },
  { name: 'h0-final-permit', file: 'convex/integrations/dispatch.ts', from: '  await checked(ctx, op);\n  const { org, global } = await budgets(ctx, op.orgId);', to: '  const { org, global } = await budgets(ctx, op.orgId);', suites: 'h0', only: 'H0#7 ' },
  { name: 'h0-grant-expiry', file: 'convex/authority/grants.ts', from: 'g.revokedAt !== undefined || g.expiresAt <= Date.now()', to: 'g.revokedAt !== undefined', suites: 'h0', only: 'H0#7 ' },
];

const results = [], pick = process.env.I1_MUTANTS?.split(',');
for (const control of controls.filter(c => !pick || pick.includes(c.name))) {
  const path = join(root, control.file), original = readFileSync(path, 'utf8'), originalSha256 = sha(original);
  assert.equal(original.split(control.from).length, 2, `${control.name}: mutation seam must be unique`);
  const mutant = original.replace(control.from, control.to);
  let result;
  try {
    writeFileSync(path, mutant);
    result = spawnSync(process.execPath, [control.script ?? 'ops/authority/service.mjs'], { cwd: root, encoding: 'utf8', timeout: 240_000, env: { ...process.env, ...(control.suites ? { I1_SUITES: control.suites } : {}), ...(control.only ? { I1_ONLY: control.only } : {}), I1_EVIDENCE_DIR: join(evidenceDir, `mutant-${control.name}`) } });
  } finally {
    writeFileSync(path, original);
    assert.equal(sha(readFileSync(path, 'utf8')), originalSha256, `${control.name}: original source was not restored`);
  }
  const output = `${result?.stdout ?? ''}${result?.stderr ?? ''}`;
  const caught = result?.status !== 0 && /AssertionError/.test(output);
  results.push({ name: control.name, file: control.file, suites: control.suites, originalSha256, mutantSha256: sha(mutant), exitCode: result?.status ?? null, signal: result?.signal ?? null, caught });
  writeFileSync(join(evidenceDir, `mutant-${control.name}.log`), output);
  console.log(caught ? 'CAUGHT' : 'SURVIVED', control.name);
}
writeFileSync(join(evidenceDir, 'service-mutants.json'), JSON.stringify({ level: 'SERVICE local backend / synthetic data only', results }, null, 2) + '\n');
assert.ok(results.every(result => result.caught), 'A SERVICE mutant survived');
