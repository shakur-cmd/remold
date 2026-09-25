// Deliberate one-line breaks in production convex/ code. Each break is applied to the
// working tree, the named checks are run, and the file is restored with git checkout.
// A break is CAUGHT when at least one named check fails; the record shows which ones.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const out = process.env.I1_EVIDENCE_DIR ?? '/tmp/i1iv/mutants';
const node = (script, env) => ({ cmd: process.execPath, args: [script], env });
const iv = only => node('evidence/2026-09-25-i1/iv/iv-service.mjs', { IV_ONLY: only });
const builder = (suites, only) => node('ops/authority/service.mjs', { I1_SUITES: suites, ...(only ? { I1_ONLY: only } : {}) });
const mutants = [
  { claim: 1, id: 'approver-recheck', file: 'convex/integrations/core.ts', from: "approver.member.role === 'member' || epoch(approver) !== approval.approverEpoch || approver.member._id !== approval.approverMembershipId", to: 'false',
    checks: { 'IV C1-A (role downgrade/re-invite)': iv('^C1-A'), 'builder: approver role downgrade': builder('authorityBoundaries', 'role downgrade') } },
  { claim: 2, id: 'legacy-freeze-cutoff', file: 'convex/identity.ts', from: 'return org.authorityFrozenAt !== undefined && object._creationTime <= org.authorityFrozenAt && agent.grants', to: 'return org.authorityFrozenAt !== undefined && agent.grants',
    checks: { 'IV migration attack (pre-backfill future object)': node('evidence/2026-09-25-i1/iv/iv-migration.mjs', {}), 'builder migration-service': node('ops/authority/migration-service.mjs', {}) }, findings: true },
  { claim: 2, id: 'expand-ignores-freeze-cutoff', file: 'convex/authority/migration.ts', from: 'const objects = await snapshot(ctx, agent.orgId, org.authorityFrozenAt), keys', to: 'const objects = await snapshot(ctx, agent.orgId), keys',
    checks: { 'IV migration attack (migrated future object)': node('evidence/2026-09-25-i1/iv/iv-migration.mjs', {}), 'builder migration-service': node('ops/authority/migration-service.mjs', {}) }, findings: true },
  { claim: 2, id: 'legacy-read-cutoff', file: 'convex/authority/reads.ts', from: 'const a = principal.agent, allowed = a.authorityVersion === 1 ? a.readObjectIds?.includes(object._id) : principal.org.authorityFrozenAt !== undefined && object._creationTime <= principal.org.authorityFrozenAt;', to: 'const a = principal.agent, allowed = a.authorityVersion === 1 ? a.readObjectIds?.includes(object._id) : principal.org.authorityFrozenAt !== undefined;',
    checks: { 'IV migration attack (pre-backfill future object)': node('evidence/2026-09-25-i1/iv/iv-migration.mjs', {}), 'builder migration-service': node('ops/authority/migration-service.mjs', {}) }, findings: true },
  { claim: 3, id: 'readonly-agent-inbox', file: 'convex/agentApi.ts', from: 'const principal = await requireAgent(ctx, args.keyHash); await writable(ctx, principal.org._id); if (!args.text.trim())', to: 'const principal = await requireAgent(ctx, args.keyHash); if (!args.text.trim())',
    checks: { 'builder readonly sweep': builder('sweeps', 'Readonly workspace') } },
  { claim: 3, id: 'mask-filter-on-hidden-field', file: 'convex/lib/list.ts', from: 'if (principal) requireQueryField(principal, object, field);', to: '',
    checks: { 'IV C3-M1/M2 (filter/sort by hidden field)': iv('^C3-M[12]$'), 'builder mask sweep + reads': builder('sweeps,reads', 'Hidden field|read') } },
  { claim: 4, id: 'secret-environment-check', file: 'convex/integrations/connections.ts', from: 'ref.environment !== connection.environment || ', to: '',
    checks: { 'IV C4-S1 (environment/provider change)': iv('^C4-S1'), 'builder secrets suite': builder('secrets') } },
];
const results = [], pick = process.env.IV_MUTANT_IDS ? process.env.IV_MUTANT_IDS.split(',') : null;
for (const m of mutants.filter(m => !pick || pick.includes(m.id))) {
  const path = join(root, m.file), source = readFileSync(path, 'utf8');
  if (source.split(m.from).length !== 2) throw new Error('Mutant anchor not unique: ' + m.id);
  writeFileSync(path, source.replace(m.from, m.to));
  const record = { ...m, checks: {} };
  try {
    for (const [name, c] of Object.entries(m.checks)) {
      const r = spawnSync(c.cmd, c.args, { cwd: root, env: { ...process.env, ...c.env, I1_EVIDENCE_DIR: join(out, m.id) }, encoding: 'utf8', maxBuffer: 1 << 26, timeout: 900000 });
      const text = (r.stdout ?? '') + (r.stderr ?? '');
      let failed = r.status !== 0 || /^FAIL /m.test(text);
      if (m.findings && /iv-migration/.test(c.args[0])) { try { failed = failed || JSON.parse(readFileSync(join(out, m.id, 'iv-migration.json'), 'utf8')).findings.some(x => ['pre-backfill', 'migrated'].includes(x.phase) && /post-freeze object allowed/.test(x.issue)); } catch { failed = true; } }
      record.checks[name] = { exit: r.status, caught: failed, evidence: text.split('\n').filter(l => /^FAIL|AssertionError|Error:|FINDINGS|allowed\/leaked|IV SUMMARY|^PASS/.test(l)).slice(0, 12).join('\n').slice(0, 1500) };
      console.log(m.id, '|', name, '|', failed ? 'CAUGHT' : 'NOT CAUGHT');
    }
  } finally { execFileSync('git', ['checkout', '--', m.file], { cwd: root }); }
  results.push(record);
}
writeFileSync(join(out, 'iv-mutants' + (pick ? '-' + pick.join('+') : '') + '.json'), JSON.stringify(results, null, 2));
execFileSync('git', ['diff', '--quiet', '--', 'convex'], { cwd: root });
console.log('convex/ restored clean');
