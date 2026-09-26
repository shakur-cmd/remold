// IV round 3: deliberate one-line breaks of each revision-2 fix, plus a take-then-filter break at every
// firstVisible call site. Each break edits one file, runs the named suites, then restores the file
// with git checkout. CAUGHT = a suite failed. Usage (repo root): node evidence/2026-09-25-i1/iv-r3/iv-r3-breaks.mjs <logdir>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
const log = process.argv[2] ?? '/tmp/iv3/breaks'; mkdirSync(log, { recursive: true });
const literal = (from, to) => src => { const n = src.split(from).length - 1; if (n !== 1) throw new Error(`expected 1 match, found ${n}: ${from.slice(0, 60)}`); return src.replace(from, () => to); };
// Wrap the first argument of the k-th firstVisible( call in await (...).take(N): exact take-then-filter at that site.
const takeAt = (k) => src => {
  const re = /firstVisible(?:<.*?>>)?\(/g; let m, i = 0;
  while ((m = re.exec(src))) { if (src.slice(m.index - 16, m.index).includes('function ')) continue; if (i++ === k) break; }
  if (!m) throw new Error('no call ' + k);
  let p = m.index + m[0].length, depth = 0, start = p;
  for (; p < src.length; p++) { const c = src[p]; if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth--; else if (c === ',' && depth === 0) break; }
  const arg = src.slice(start, p), rest = src.slice(p + 1), limit = /^\s*([^,]+),/.exec(rest)[1].trim();
  return src.slice(0, start) + `await (${arg}).take(${limit})` + src.slice(p);
};
const suites = { unit: ['pnpm', ['-s', 'test:authority']], app: ['pnpm', ['-s', 'test']], release: ['pnpm', ['-s', 'verify:release']] };
const breaks = [
  ['R1 shape: Object.hasOwn back to `in`', 'convex/lib/shape.ts', literal('!Object.hasOwn(fields, key)', '!(key in fields)'), ['unit', 'app']],
  ['R2 helper: stop after limit rows scanned', 'convex/authority/reads.ts', literal('if (out.length >= limit || ++scanned >= scanCap) break;', 'if (++scanned >= limit) break;'), ['unit', 'app']],
  ['R2 helper: drop the scan cap entirely (widening reads, not a leak)', 'convex/authority/reads.ts', literal(' || ++scanned >= scanCap) break;', ') break;'), ['unit', 'app']],
  ['R3 events.forRecord: drop the read check', 'convex/events.ts', literal('if (!record || !object || !canReadRecord(principal, object, record)) fail(', 'if (!record || !object) fail('), ['unit', 'app']],
  ['R3 records.related: drop the target read check', 'convex/records.ts', literal('!canReadRecord(principal, targetObject, target) || ', ''), ['unit', 'app']],
  ['R4 floor: drop the ancestry clause', 'ops/release/release.mjs', literal("return spawnSync('git', ['merge-base', '--is-ancestor', floorSha, targetSha], { cwd }).status === 0\n    && ", 'return '), ['release']],
  ['D6 guard: ignore the own check in the map test', 'ops/authority/h0-parity.test.ts', literal("    if (!own.test(covered)) gaps.push(", "    if (false) gaps.push("), ['unit']],
  ['D6 guard: MAX_SHARED 6 -> 60', 'ops/authority/h0-parity.test.ts', literal('const MAX_SHARED = 6;', 'const MAX_SHARED = 60;'), ['unit']],
  ['D6 data: row 12 own check replaced by row 10 pattern', 'ops/authority/h0-parity.json', src => { const j = JSON.parse(src); j[11].exercises = j[9].exercises; return JSON.stringify(j, null, 2) + '\n'; }, ['unit']],
  ['D6 data: row 38 own check swapped for generic "assert\\.equal"', 'ops/authority/h0-parity.json', src => { const j = JSON.parse(src); j[37].exercises = 'assert\\.equal'; return JSON.stringify(j, null, 2) + '\n'; }, ['unit']],
];
const sites = [['convex/records.ts', 0, 'records.search'], ['convex/agentApi.ts', 0, 'agent search'], ['convex/agentApi.ts', 1, 'agent related links'], ['convex/agentApi.ts', 2, 'agent related lookup'], ['convex/agentApi.ts', 3, 'agent today tasks'], ['convex/agentApi.ts', 4, 'agent today quiet'], ['convex/agentApi.ts', 5, 'agent listSuggestions'], ['convex/agentApi.ts', 6, 'agent inbox'], ['convex/inbox.ts', 0, 'inbox.list'], ['convex/suggestions.ts', 0, 'suggestions.list'], ['convex/today.ts', 0, 'today tasks'], ['convex/today.ts', 1, 'today quiet'], ['convex/lib/find.ts', 0, 'findReadableByTitle']];
for (const [file, k, name] of sites) breaks.push([`R2 site take-then-filter: ${name}`, file, takeAt(k), ['unit', 'app']]);
const out = [];
const onlyRe = process.env.BREAKS_ONLY ? new RegExp(process.env.BREAKS_ONLY) : null;
for (const [id, file, edit, run] of breaks) {
  if (onlyRe && !onlyRe.test(id)) continue;
  const before = readFileSync(file, 'utf8'); let after;
  try { after = edit(before); } catch (e) { out.push({ id, result: 'NOT APPLIED: ' + e.message }); console.log('NOT APPLIED', id, e.message); continue; }
  writeFileSync(file, after); const diff = execFileSync('git', ['diff', '-U0', '--', file], { encoding: 'utf8' }).split('\n').filter(l => /^[+-][^+-]/.test(l)).map(l => l.slice(0, 220));
  let failed = null, detail = '';
  for (const s of run) { const r = spawnSync(suites[s][0], suites[s][1], { encoding: 'utf8' }); const text = r.stdout + r.stderr; writeFileSync(`${log}/${id.replace(/[^a-z0-9]+/gi, '_')}.${s}.log`, text); if (r.status !== 0) { failed = s; detail = text.split('\n').filter(l => /FAIL|✖|×|AssertionError|expected/.test(l)).slice(0, 4).join(' | ').slice(0, 400); break; } }
  execFileSync('git', ['checkout', '-q', '--', file]);
  out.push({ id, file, diff, result: failed ? 'CAUGHT by ' + failed : 'MISSED (' + run.join('+') + ' green)', detail });
  console.log(failed ? 'CAUGHT' : 'MISSED', id, failed ? '<- ' + failed + ': ' + detail.slice(0, 200) : '');
}
writeFileSync(`${log}/breaks.json`, JSON.stringify(out, null, 2) + '\n');
console.log('clean tree after breaks:', execFileSync('git', ['status', '--short', '--', 'convex', 'ops'], { encoding: 'utf8' }).trim() || 'yes');
