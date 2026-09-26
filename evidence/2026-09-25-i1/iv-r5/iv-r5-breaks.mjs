// IV round 5 (adapted from ../iv-r4/iv-r4-breaks.mjs to revision 4): adds breaks of pending.ts, compareValues and
// the clean cursor refusal. Original header: IV round 4: deliberate one-line breaks of each revision-3 fix (explicit-list paths, events merge, search,
// name matching, daily lists), the remaining firstVisible sites, and the carried R1/R3/R4/D6 fixes.
// Each break edits one file, runs the named suites, then restores the file with git checkout.
// CAUGHT = a suite failed. Usage (repo root): node evidence/2026-09-25-i1/iv-r4/iv-r4-breaks.mjs <logdir>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
const log = process.argv[2] ?? '/tmp/iv4/breaks'; mkdirSync(log, { recursive: true });
const literal = (from, to) => src => { const n = src.split(from).length - 1; if (n !== 1) throw new Error(`expected 1 match, found ${n}: ${from.slice(0, 70)}`); return src.replace(from, () => to); };
const suites = { unit: ['pnpm', ['-s', 'test:authority']], app: ['pnpm', ['-s', 'test']], release: ['pnpm', ['-s', 'verify:release']] };
const json = (i, v) => src => { const j = JSON.parse(src); j[i].exercises = v; return JSON.stringify(j, null, 2) + '\n'; };
const breaks = [
  ['P listedRecordIds always null (no list path anywhere)', 'convex/authority/reads.ts', literal("if (all.some(s => s.records === 'all')) return null;", 'return null;'), ['unit', 'app']],
  ['P pageRecords list path off', 'convex/lib/list.ts', literal('  if (listed) {', '  if (false && listed) {'), ['unit', 'app']],
  ['P list path ignores filter', 'convex/lib/list.ts', literal('if (filter) rows = rows.filter(', 'if (false) rows = rows.filter('), ['unit', 'app']],
  ['P list path ignores desc', 'convex/lib/list.ts', literal('if (sort?.direction === "desc") rows.reverse();', ''), ['unit', 'app']],
  ['P list path tie-break dropped', 'convex/lib/list.ts', literal('rows = [...rows].sort((a, b) => compareIndexValues(at(a), at(b)) || a._creationTime - b._creationTime);', 'rows = [...rows].sort((a, b) => compareIndexValues(at(a), at(b)));'), ['unit', 'app']],
  ['P pageList isDone off by one', 'convex/authority/reads.ts', literal('isDone: end >= rows.length', 'isDone: end > rows.length'), ['unit', 'app']],
  ['P records.related list path off', 'convex/records.ts', literal('  if (listed) { const page = pageList(listed', '  if (false && listed) { const page = pageList(listed'), ['unit', 'app']],
  ['P agent related list path off', 'convex/lib/list.ts', literal('  const listed = await listedRecords(ctx, principal, source);\n  if (!listed) return null;', '  const listed = await listedRecords(ctx, principal, source);\n  if (!listed || true) return null;'), ['unit', 'app']],
  ['P csv list path off', 'convex/csv.ts', literal('const page = listed ?', 'const page = false && listed ?'), ['unit', 'app']],
  ['P events merge off', 'convex/events.ts', literal('const page = restricted ?', 'const page = false ?'), ['unit', 'app']],
  ['P events merge keeps already-seen ids', 'convex/events.ts', literal('.flat().filter(e => !seen.includes(e._id));', '.flat();'), ['unit', 'app']],
  ['P events: listed objects streamed whole', 'convex/events.ts', literal('if (ids === null) streams.push', 'if (true) streams.push'), ['unit', 'app']],
  ['F search: record-scoped treated as fully searchable', 'convex/lib/search.ts', literal('depth > 5 || listedRecordIds(principal, object) !== null ||', 'depth > 5 ||'), ['unit', 'app']],
  ['F search recent: list path off', 'convex/lib/search.ts', literal('return listed ? listed.sort(', 'return false && listed ? listed.sort('), ['unit', 'app']],
  ['F name match list path off', 'convex/lib/find.ts', literal('  if (listed) return listed.filter(record => record.title', '  if (false) return listed!.filter(record => record.title'), ['unit', 'app']],
  ['F dueTasks list path off', 'convex/lib/daily.ts', literal('  if (listed) return listed.filter(row => canReadField(principal, task, due', '  if (false) return listed!.filter(row => canReadField(principal, task, due'), ['unit', 'app']],
  ['F quietDeals list path off', 'convex/lib/daily.ts', literal('  if (listed) return listed.filter(row => !stage', '  if (false) return listed!.filter(row => !stage'), ['unit', 'app']],
  ['F dueTasks index path skips canReadRecord', 'convex/lib/daily.ts', literal('limit, row => open(row) && canReadRecord(principal, task, row) ? row : null);', 'limit, row => open(row) ? row : null);'), ['unit', 'app']],
  ['S suggestions: record-scoped callers read the org-wide index', 'convex/authority/pending.ts', literal('  if (everything) streams.splice(', '  if (true) streams.splice('), ['unit', 'app']],
  ['S suggestions: final readability filter dropped', 'convex/authority/pending.ts', literal("return (await merge(streams, 'desc', limit)).filter(s => { const o = byId.get(s.change.objectId); return !!o && canReadRecordId(principal, o, s.change.recordId); });", "return (await merge(streams, 'desc', limit));"), ['unit', 'app']],
  ['S suggestions: per-record stream ignores status', 'convex/authority/pending.ts', literal(".order('desc').filter(q => q.eq(q.field('status'), status)));", ".order('desc'));"), ['unit', 'app']],
  ['S merge: newest-first sort reversed', 'convex/authority/pending.ts', literal("order === 'asc' ? a._creationTime - b._creationTime : b._creationTime - a._creationTime", "a._creationTime - b._creationTime"), ['unit', 'app']],
  ['S merge: no de-duplication', 'convex/authority/pending.ts', literal('const unique = [...new Map(rows.map(r => [r._id, r])).values()]', 'const unique = [...rows]'), ['unit', 'app']],
  ['S inbox: restricted callers read the whole org index', 'convex/authority/pending.ts', literal('  if (unrestrictedHuman(principal)) streams.push(', '  if (true) streams.push('), ['unit', 'app']],
  ['S inbox: shared stream for everyone', 'convex/authority/pending.ts', literal('    if (sharedInboxReader(principal)) {', '    if (true) {'), ['unit', 'app']],
  ['S inbox: legacy pre-freeze items not streamed', 'convex/authority/pending.ts', literal('      if (frozenAt !== undefined) streams.push(', '      if (false) streams.push('), ['unit', 'app']],
  ['S inbox: legacy stream ignores the freeze bound', 'convex/authority/pending.ts', literal(".eq('audience', undefined).lte('_creationTime', frozenAt))", ".eq('audience', undefined))"), ['unit', 'app']],
  ['S inbox: final canSeeInbox filter dropped', 'convex/authority/pending.ts', literal("return (await merge(streams, 'asc', limit)).filter(item => canSeeInbox(principal, item));", "return (await merge(streams, 'asc', limit));"), ['unit', 'app']],
  ['O compareValues back to JS UTF-16 compare', 'convex/authority/reads.ts', literal('return compareValues(a as Value | undefined, b as Value | undefined);', "return (a as any) < (b as any) ? -1 : (a as any) > (b as any) ? 1 : 0;"), ['unit', 'app']],
  ['C paginateIndex passes list: cursors to Convex', 'convex/authority/reads.ts', literal("some(c => typeof c === 'string' && /^(list|events):/.test(c))", 'some(c => false)'), ['unit', 'app']],
  ['R1 shape: Object.hasOwn back to `in`', 'convex/lib/shape.ts', literal('!Object.hasOwn(fields, key)', '!(key in fields)'), ['unit', 'app']],
  ['R3 events.forRecord: drop the read check', 'convex/events.ts', literal('if (!record || !object || !canReadRecord(principal, object, record)) fail(', 'if (!record || !object) fail('), ['unit', 'app']],
  ['R3 records.related: drop the target read check', 'convex/records.ts', literal('!canReadRecord(principal, targetObject, target) || ', ''), ['unit', 'app']],
  ['R4 floor: drop the ancestry clause', 'ops/release/release.mjs', literal("if (!ok('merge-base', '--is-ancestor', floorSha, targetSha)) return", "if (false) return"), ['release']],
  ['R4 floor: generic refusal message', 'ops/release/release.mjs', literal("if (type !== 'commit') return `rollback target ${targetSha} is a ${type}, not a commit`;", "if (type !== 'commit') return 'refused';"), ['release']],
  ['D6 guard: own-check line disabled', 'ops/authority/h0-parity.test.ts', literal('    if (!own.test(covered)) gaps.push(', '    if (false) gaps.push('), ['unit']],
  ['D6 guard: MAX_SHARED 6 -> 60', 'ops/authority/h0-parity.test.ts', literal('const MAX_SHARED = 6;', 'const MAX_SHARED = 60;'), ['unit']],
  ['D6 row 5 own check -> old revoke pattern', 'ops/authority/h0-parity.json', json(4, 'childRead\\('), ['unit']],
  ['D6 row 8 own check -> old key pattern', 'ops/authority/h0-parity.json', json(7, 'revoked agent key'), ['unit']],
  ['D6 row 38 own check -> old exposure pattern', 'ops/authority/h0-parity.json', json(37, 'second\\.maxUnits, 3'), ['unit']],
];
const onlyRe = process.env.BREAKS_ONLY ? new RegExp(process.env.BREAKS_ONLY) : null;
const out = [];
for (const [id, file, edit, run] of breaks) {
  if (onlyRe && !onlyRe.test(id)) continue;
  const before = readFileSync(file, 'utf8'); let after;
  try { after = edit(before); } catch (e) { out.push({ id, result: 'NOT APPLIED: ' + e.message }); console.log('NOT APPLIED', id, e.message); continue; }
  writeFileSync(file, after); const diff = execFileSync('git', ['diff', '-U0', '--', file], { encoding: 'utf8' }).split('\n').filter(l => /^[+-][^+-]/.test(l)).map(l => l.slice(0, 220));
  let failed = null, detail = '';
  for (const s of run) { const r = spawnSync(suites[s][0], suites[s][1], { encoding: 'utf8' }); const text = r.stdout + r.stderr; writeFileSync(`${log}/${id.replace(/[^a-z0-9]+/gi, '_')}.${s}.log`, text); if (r.status !== 0) { failed = s; detail = text.split('\n').filter(l => /×|✖|FAIL /.test(l)).slice(0, 3).join(' | ').slice(0, 400); break; } }
  execFileSync('git', ['checkout', '-q', '--', file]);
  out.push({ id, file, diff, result: failed ? 'CAUGHT by ' + failed : 'MISSED (' + run.join('+') + ' green)', detail });
  console.log(failed ? 'CAUGHT' : 'MISSED', id, failed ? '<- ' + failed + ': ' + detail.slice(0, 220) : '');
}
writeFileSync(`${log}/breaks.json`, JSON.stringify(out, null, 2) + '\n');
console.log('tree after breaks:', execFileSync('git', ['status', '--short', '--', 'convex', 'ops'], { encoding: 'utf8' }).trim() || 'clean');
