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
  // Legacy wildcard widening: both freeze cutoffs removed, so a post-freeze object becomes writable and readable.
  { name: 'wildcard-widening', edits: [
    { file: 'convex/identity.ts', from: 'org.authorityFrozenAt !== undefined && object._creationTime <= org.authorityFrozenAt && agent.grants', to: 'org.authorityFrozenAt !== undefined && agent.grants' },
    { file: 'convex/authority/reads.ts', from: 'allowed = a.authorityVersion === 1 ? a.readObjectIds?.includes(object._id) : principal.org.authorityFrozenAt !== undefined && object._creationTime <= principal.org.authorityFrozenAt;', to: 'allowed = a.authorityVersion === 1 ? a.readObjectIds?.includes(object._id) : principal.org.authorityFrozenAt !== undefined;' },
  ], script: 'ops/authority/migration-service.mjs', expect: /frozen-before-backfill (create|update|delete|list|get)\s+(200|204) !== (403|404)/ },
  { name: 'migrate-expands-all', file: 'convex/authority/migration.ts', from: 'await snapshot(ctx, agent.orgId, org.authorityFrozenAt)).map', to: 'await snapshot(ctx, agent.orgId)).map', script: 'ops/authority/migration-service.mjs', expect: /migrated (create|update|delete|list|get)\s+(200|204) !== (403|404)/ },
  { name: 'hidden-sort-filter', file: 'convex/lib/list.ts', from: '  if (principal) requireQueryField(principal, object, field);\n', to: '', suites: 'sweeps', only: 'Hidden field value', expect: /by a hidden field/ },
  { name: 'secret-environment', file: 'convex/integrations/connections.ts', from: ' || ref.environment !== connection.environment', to: '', suites: 'secrets', only: 'Invalid provider and secret', expect: /environment/ },
  { name: 'adapter-body-logged', file: 'convex/integrations/http.ts', from: "    if (!ids || (ids.length && !await ctx.runQuery(makeFunctionReference<'query'>('lib/shape:idsBelong'), { ids }))) return json({ error: { code: 'VALIDATION', message: 'Invalid adapter arguments' } }, 400);\n", to: '', suites: 'secrets', only: 'reveal no secrets', expect: /log contains the (forwarded body field|adapter key SHA-256)/ },
  { name: 'operator-secret-readonly', file: 'convex/integrations/connections.ts', from: 'await provider(ctx, args.provider); await writable(ctx, args.orgId);', to: 'await provider(ctx, args.provider);', suites: 'sweeps', only: 'Operator-internal', expect: /registerSecret is labelled refused/ },
  { name: 'mask-sweep', file: 'convex/authority/reads.ts', from: '!hidden?.includes(field._id) && ', to: '', suites: 'sweeps' },
  { name: 'h0-final-permit', file: 'convex/integrations/dispatch.ts', from: '  await checked(ctx, op);\n  const { org, global } = await budgets(ctx, op.orgId);', to: '  const { org, global } = await budgets(ctx, op.orgId);', suites: 'h0', only: 'H0#7 ' },
  { name: 'h0-grant-expiry', file: 'convex/authority/grants.ts', from: 'g.revokedAt !== undefined || g.expiresAt <= Date.now()', to: 'g.revokedAt !== undefined', suites: 'h0', only: 'H0#7 ' },
];

const results = [], pick = process.env.I1_MUTANTS?.split(',');
for (const control of controls.filter(c => !pick || pick.includes(c.name))) {
  const edits = (control.edits ?? [control]).map(edit => { const path = join(root, edit.file), original = readFileSync(path, 'utf8'); assert.equal(original.split(edit.from).length, 2, `${control.name}: mutation seam in ${edit.file} must be unique`); return { ...edit, path, original, mutant: original.replace(edit.from, edit.to) }; });
  const originalSha256 = sha(edits.map(e => e.original).join('\0')), mutant = edits.map(e => e.mutant).join('\0');
  let result;
  try {
    for (const edit of edits) writeFileSync(edit.path, edit.mutant);
    result = spawnSync(process.execPath, [control.script ?? 'ops/authority/service.mjs'], { cwd: root, encoding: 'utf8', timeout: 240_000, env: { ...process.env, ...(control.suites ? { I1_SUITES: control.suites } : {}), ...(control.only ? { I1_ONLY: control.only } : {}), I1_EVIDENCE_DIR: join(evidenceDir, `mutant-${control.name}`) } });
  } finally {
    for (const edit of edits) { writeFileSync(edit.path, edit.original); assert.equal(readFileSync(edit.path, 'utf8'), edit.original, `${control.name}: ${edit.file} was not restored`); }
  }
  const output = `${result?.stdout ?? ''}${result?.stderr ?? ''}`;
  // Caught only by the intended assertion, not by an unrelated failure such as a changed status code.
  const caught = result?.status !== 0 && /AssertionError/.test(output) && (!control.expect || control.expect.test(output));
  results.push({ name: control.name, files: edits.map(e => e.file), suites: control.suites, originalSha256, mutantSha256: sha(mutant), exitCode: result?.status ?? null, signal: result?.signal ?? null, caught });
  writeFileSync(join(evidenceDir, `mutant-${control.name}.log`), output);
  console.log(caught ? 'CAUGHT' : 'SURVIVED', control.name);
}
writeFileSync(join(evidenceDir, 'service-mutants.json'), JSON.stringify({ level: 'SERVICE local backend / synthetic data only', results }, null, 2) + '\n');
assert.ok(results.every(result => result.caught), 'A SERVICE mutant survived');
