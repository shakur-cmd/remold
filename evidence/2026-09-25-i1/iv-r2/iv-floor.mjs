// Probes release.mjs authorityFloor on a throwaway clone. Nothing is pushed.
// Usage: node evidence/2026-09-25-i1/iv-r2/iv-floor.mjs <repo> <scratch-dir>
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { authorityFloor, preflight } from '../../../ops/release/release.mjs';
const [source, scratch] = process.argv.slice(2);
rmSync(scratch, { recursive: true, force: true });
execFileSync('git', ['clone', '-q', '--no-checkout', source, scratch]);
const git = (...a) => execFileSync('git', a, { cwd: scratch, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'iv', GIT_AUTHOR_EMAIL: 'iv@example.test', GIT_COMMITTER_NAME: 'iv', GIT_COMMITTER_EMAIL: 'iv@example.test' } }).trim();
const full = ref => git('rev-parse', ref + '^{commit}');
const refuse = sha => { try { preflight({ release: { rollbackTarget: sha, class: 'ui-only' }, schemaSha256: 'x' }, sha, 'x', undefined, undefined, undefined, authorityFloor(scratch, sha)); return 'accepted'; } catch (e) { return 'refused: ' + e.message.slice(0, 80); } };
const rows = [];
const row = (name, sha, expect) => { const floor = (() => { try { return authorityFloor(scratch, sha); } catch (e) { return 'throws: ' + e.message; } })(); rows.push({ name, sha, floor, preflight: typeof floor === 'boolean' ? refuse(sha) : 'n/a', expect }); };
row('pre-I1 3339517', full('3339517'), 'refuse');
row('I1 first handover d2c8744', full('d2c8744'), 'accept');
row('I1 revision 1 f1de701', full('f1de701'), 'accept');
row('I1 revision 1 evidence 4cb4671', full('4cb4671'), 'accept');
row('7299ee9 (builder named it accepted)', full('7299ee9'), 'accept');
row('abbreviated sha', '3339517', 'refuse');
row('unknown full sha', 'f'.repeat(40), 'refuse');
// Attack 1: pre-I1 code plus two empty files at the marker paths.
git('checkout', '-q', '--detach', full('3339517'));
mkdirSync(join(scratch, 'convex/authority'), { recursive: true });
writeFileSync(join(scratch, 'convex/authority/migration.ts'), ''); writeFileSync(join(scratch, 'convex/authority/reads.ts'), '');
git('add', 'convex/authority/migration.ts', 'convex/authority/reads.ts'); git('commit', '-q', '-m', 'stub markers on pre-I1 code');
row('ATTACK pre-I1 code + empty marker stubs', git('rev-parse', 'HEAD'), 'refuse');
// Attack 2: I1 code with record-scope enforcement switched off but files kept.
git('checkout', '-q', '--detach', full('4cb4671'));
git('rm', '-q', 'convex/authority/reads.ts'); git('commit', '-q', '-m', 'drop reads.ts');
row('I1 minus reads.ts', git('rev-parse', 'HEAD'), 'refuse');
git('checkout', '-q', '--detach', full('4cb4671'));
execFileSync('sed', ['-i', '', 's/^export function canReadRecordId(principal: Principal, object: Doc<.objects.>, recordId?: Id<.records.>) {$/&\\n  return true;/', 'convex/authority/reads.ts'], { cwd: scratch });
git('commit', '-q', '-am', 'canReadRecordId returns true');
row('ATTACK I1 files kept, canReadRecordId returns true', git('rev-parse', 'HEAD'), 'refuse');
const rootTree = git('rev-parse', full('4cb4671') + '^{tree}');
row('tree object of 4cb4671 (not a commit)', rootTree, 'refuse');
console.log(JSON.stringify(rows, null, 2));
const fooled = rows.filter(r => r.expect === 'refuse' && r.floor === true).map(r => r.name), wrongRefuse = rows.filter(r => r.expect === 'accept' && r.floor !== true).map(r => r.name);
console.log('FOOLED BY:', fooled.length ? fooled.join('; ') : 'none'); console.log('WRONGLY REFUSED:', wrongRefuse.length ? wrongRefuse.join('; ') : 'none');
