// Deliberate breaks of each revision-1 fix (D1-D8, rollback floor). Each break is applied to
// the working tree, the named checks run, and the file is restored with git checkout.
// A break is CAUGHT when at least one named check fails.
// Usage: I1_EVIDENCE_DIR=<dir> [IV_MUTANT_IDS=a,b] node evidence/2026-09-25-i1/iv-r2/iv-mutants-r2.mjs
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const out = process.env.I1_EVIDENCE_DIR ?? '/tmp/ivr2/mutants';
const node = (args, env = {}) => ({ cmd: process.execPath, args, env });
const iv = only => node(['evidence/2026-09-25-i1/iv/iv-service.mjs'], { IV_ONLY: only });
const r2 = only => node(['evidence/2026-09-25-i1/iv-r2/iv-r2.mjs'], { IV_ONLY: only });
const builder = (suites, only) => node(['ops/authority/service.mjs'], { I1_SUITES: suites, ...(only ? { I1_ONLY: only } : {}) });
const unit = file => node([join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'ops/authority/vitest.config.ts', file]);
const readonlyChecks = { 'builder sweep: operator-internal labels': builder('sweeps', 'Operator-internal'), 'IV R2-R1': r2('^R2-R1$') };
const mutants = [
  { d: 'D1', id: 'csv-skip-duplicates-any-record', file: 'convex/csv.ts', edits: [['import { findReadableByTitle } from "./lib/find";', 'import { findReadableByTitle, findByTitle } from "./lib/find";'], ['(await findReadableByTitle(ctx, membership, object, title))', '(await findByTitle(ctx, args.orgId, object._id, title))']],
    checks: { 'IV C3-M4': iv('^C3-M4$'), 'unit oracles.test': unit('ops/authority/oracles.test.ts'), 'IV R2-O1': r2('^R2-O1$') } },
  { d: 'D1', id: 'csv-lookup-code-not-found', file: 'convex/csv.ts', edits: [['if (object && canReadRecord(run.membership, object, byRef)) return byRef._id; }', 'if (object) { if (!canReadRecord(run.membership, object, byRef)) fail("NOT_FOUND", "Record not found"); return byRef._id; } }']],
    checks: { 'unit oracles.test': unit('ops/authority/oracles.test.ts'), 'IV R2-O1': r2('^R2-O1$') } },
  { d: 'D1', id: 'csv-lookup-title-not-found', file: 'convex/csv.ts', edits: [['import { findReadableByTitle } from "./lib/find";', 'import { findReadableByTitle, findByTitle } from "./lib/find";'], ['const found = await findReadableByTitle(ctx, run.membership, target, text);', 'const found = await findByTitle(ctx, orgId, target._id, text); if (found && !canReadRecord(run.membership, target, found)) fail("NOT_FOUND", "Record not found");']],
    checks: { 'unit oracles.test': unit('ops/authority/oracles.test.ts'), 'IV R2-O1': r2('^R2-O1$') } },
  { d: 'D2', id: 'capture-company-not-found', file: 'convex/capture.ts', edits: [['import { findReadableByTitle } from "./lib/find";', 'import { findReadableByTitle, findByTitle } from "./lib/find";\nimport { canReadRecord } from "./authority/reads";'], ['const existing = await findReadableByTitle(ctx, membership, company.object, name);', 'const existing = await findByTitle(ctx, orgId, company.object._id, name); if (existing && !canReadRecord(membership, company.object, existing)) fail("NOT_FOUND", "Record not found");']],
    checks: { 'IV C3-M5': iv('^C3-M5$'), 'unit oracles.test': unit('ops/authority/oracles.test.ts'), 'IV R2-O6': r2('^R2-O6$') } },
  { d: 'D3', id: 'agent-lookup-title-not-found', file: 'convex/lib/values.ts', edits: [['import { findReadableByTitle } from "./find";', 'import { findReadableByTitle, findByTitle } from "./find";'], ['const record = object ? await findReadableByTitle(ctx, principal, object, value) : null;', 'const record = object ? await findByTitle(ctx, orgId, object._id, value) : null; if (record && object && !canReadRecord(principal, object, record)) fail("NOT_FOUND", "Record not found");']],
    checks: { 'IV C3-M6': iv('^C3-M6$'), 'unit oracles.test': unit('ops/authority/oracles.test.ts'), 'IV R2-O3': r2('^R2-O3$') } },
  { d: 'D3', id: 'propose-scope-after-resolution', file: 'convex/agentApi.ts', edits: [['if (!canPropose(principal, target.item.object, target.record?._id, touched)) fail("FORBIDDEN", "Proposal scope required");', '']],
    checks: { 'IV C3-M6': iv('^C3-M6$'), 'unit oracles.test': unit('ops/authority/oracles.test.ts'), 'IV R2-O3': r2('^R2-O3$') } },
  { d: 'D4', id: 'readonly-registerSecret', file: 'convex/integrations/connections.ts', edits: [['await provider(ctx, args.provider); await writable(ctx, args.orgId);', 'await provider(ctx, args.provider);']], checks: readonlyChecks },
  { d: 'D4', id: 'readonly-org-budget', file: 'convex/integrations/budgets.ts', edits: [['if (args.orgId) await writable(ctx, args.orgId);', 'if (args.orgId && !(await ctx.db.get(args.orgId))) fail("NOT_FOUND");']], checks: readonlyChecks },
  { d: 'D4', id: 'readonly-seed-ensureStandard', file: 'convex/seed.ts', edits: [['handler: async (ctx, args) => { await writable(ctx, args.orgId); return seedStandard(ctx, args.orgId); },', 'handler: async (ctx, args) => seedStandard(ctx, args.orgId),']], checks: readonlyChecks },
  { d: 'D5', id: 'new-agent-subroute', file: 'convex/http.ts', edits: [['  return bad("NOT_FOUND", "Route not found", 404);\n}', '  if (request.method === "GET" && path[0] === "records" && path[2] === "dump" && path.length === 3) return json(await query(internal.agentApi.getRecord, { idOrRef: path[1] }));\n  return bad("NOT_FOUND", "Route not found", 404);\n}']],
    checks: { 'unit inventory.test': unit('ops/authority/inventory.test.ts') } },
  { d: 'D7', id: 'frozen-key-ignored', file: 'convex/authority/migration.ts', edits: [["=> org.authorityFrozenKeys?.[object._id] ?? object.key;", '=> object.key;']],
    checks: { 'unit migration.test': unit('ops/authority/migration.test.ts'), 'IV R2-K1': r2('^R2-K1$') } },
  { d: 'D8', id: 'shape-allows-extra-keys', file: 'convex/lib/shape.ts', edits: [['if (Object.keys(record).some(key => !(key in fields))) return false;', '']],
    checks: { 'IV C4-S2': iv('^C4-S2$'), 'IV R2-D8c': r2('^R2-D8c$'), 'builder secrets': builder('secrets') } },
  { d: 'D8', id: 'rest-body-check-skipped', file: 'convex/http.ts', edits: [['if (!ids || (ids.length && !await ctx.runQuery(makeFunctionReference<"query">("lib/shape:idsBelong"), { ids }))) throw', 'if (false) throw']],
    checks: { 'IV C4-S2': iv('^C4-S2$'), 'IV R2-D8c': r2('^R2-D8c$'), 'builder secrets': builder('secrets') } },
  { d: 'floor', id: 'floor-always-true', file: 'ops/release/release.mjs', edits: [['return AUTHORITY_CORE.every(', 'return true || AUTHORITY_CORE.every(']],
    checks: { 'release tests': node(['--test', 'ops/release/release.test.mjs']) } },
];
const results = [], pick = process.env.IV_MUTANT_IDS ? process.env.IV_MUTANT_IDS.split(',') : null;
mkdirSync(out, { recursive: true });
for (const m of mutants.filter(m => !pick || pick.includes(m.id))) {
  const path = join(root, m.file); let source = readFileSync(path, 'utf8');
  for (const [from, to] of m.edits) { if (source.split(from).length !== 2) throw new Error('Mutant anchor not unique: ' + m.id + ' :: ' + from); source = source.replace(from, () => to); }
  writeFileSync(path, source);
  const record = { d: m.d, id: m.id, file: m.file, edits: m.edits, checks: {} };
  try {
    for (const [name, c] of Object.entries(m.checks)) {
      const r = spawnSync(c.cmd, c.args, { cwd: root, env: { ...process.env, ...c.env, I1_EVIDENCE_DIR: join(out, m.id) }, encoding: 'utf8', maxBuffer: 1 << 26, timeout: 1200000 });
      const text = (r.stdout ?? '') + (r.stderr ?? '');
      const failed = r.status !== 0 || /^FAIL /m.test(text) || /^not ok /m.test(text);
      record.checks[name] = { exit: r.status, caught: failed, evidence: text.split('\n').filter(l => /^FAIL|AssertionError|Error:|SUMMARY|FAIL |✗|×|not ok|Tests +\d|^# (pass|fail)/.test(l)).slice(0, 10).join('\n').slice(0, 1500) };
      console.log(m.d, '|', m.id, '|', name, '|', failed ? 'CAUGHT' : 'NOT CAUGHT');
    }
  } finally { execFileSync('git', ['checkout', '--', m.file], { cwd: root }); }
  record.caught = Object.values(record.checks).some(c => c.caught);
  results.push(record);
}
writeFileSync(join(out, 'iv-mutants-r2' + (pick ? '-' + pick.join('+') : '') + '.json'), JSON.stringify(results, null, 2));
execFileSync('git', ['diff', '--quiet', '--', 'convex', 'ops/release'], { cwd: root });
console.log('convex/ and ops/release restored clean');
