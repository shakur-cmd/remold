// IV round 4 (copy of ../iv-r3/iv-r3-floor.mjs, tip 87d4c10, prints authorityFloorCheck reasons): probes authorityFloor (ancestry pin 7299ee98 + marker paths) on a throwaway clone. Nothing is pushed.
// Usage: node evidence/2026-09-25-i1/iv-r3/iv-r3-floor.mjs <repo> <scratch-dir>
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { authorityFloor, authorityFloorCheck, preflight, FIRST_I1_COMMIT } from '../../../ops/release/release.mjs';
const [source, scratch] = process.argv.slice(2);
rmSync(scratch, { recursive: true, force: true });
execFileSync('git', ['clone', '-q', '--no-checkout', source, scratch]);
const env = { ...process.env, GIT_AUTHOR_NAME: 'iv', GIT_AUTHOR_EMAIL: 'iv@example.test', GIT_COMMITTER_NAME: 'iv', GIT_COMMITTER_EMAIL: 'iv@example.test' };
const gitIn = dir => (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const git = gitIn(scratch);
const full = ref => git('rev-parse', ref + '^{commit}');
const rows = [];
const verdict = (cwd, sha) => { try { return authorityFloor(cwd, sha); } catch (e) { return 'throws: ' + e.message; } };
const pre = (cwd, sha, floor) => { try { preflight({ release: { rollbackTarget: sha, class: 'ui-only' }, schemaSha256: 'x' }, sha, 'x', undefined, undefined, undefined, floor); return 'accepted'; } catch (e) { return 'refused: ' + e.message.slice(0, 70); } };
const row = (name, sha, expect, cwd = scratch) => { const floor = verdict(cwd, sha); rows.push({ name, sha, floor, reason: (() => { try { const r = authorityFloorCheck(cwd, sha); return r === true ? 'ok' : r; } catch (e) { return 'throws: ' + e.message; } })(), preflight: typeof floor === 'boolean' ? pre(cwd, sha, floor) : 'n/a', expect }); };
const I1 = full('87d4c10'), MAIN = full('origin/main'), PRE = full('3339517');
row('pre-I1 3339517', PRE, 'refuse');
row('floor commit 7299ee9 itself', FIRST_I1_COMMIT, 'accept');
row('round-1 code d2c8744 (known D1-D3 oracles)', full('d2c8744'), 'accept (floor is only "not pre-I1")');
row('revision 3 87d4c10', I1, 'accept');
row('origin/main today (no I1)', MAIN, 'refuse');
// 1. Normal merge commit bringing I1 into main.
git('checkout', '-q', '-B', 'm', MAIN); git('merge', '-q', '--no-ff', '--no-edit', '-X', 'theirs', I1);
row('merge commit of I1 into main', git('rev-parse', 'HEAD'), 'accept');
// 2. Squash merge of I1 into main: same tree, no ancestry.
git('checkout', '-q', '-B', 's', MAIN); git('merge', '-q', '--squash', '-X', 'theirs', I1); git('commit', '-q', '-m', 'squash I1');
const squash = git('rev-parse', 'HEAD'); row('squash-merge of I1 into main', squash, 'refuse (fail closed, documented)');
git('commit', '-q', '--allow-empty', '-m', 'later work on squashed main'); row('later commit on squashed main', git('rev-parse', 'HEAD'), 'refuse (fail closed, documented)');
// 3. Descendant of I1 whose tree is pre-I1 code plus empty marker files.
git('checkout', '-q', '--detach', I1); git('rm', '-q', '-r', '--', '.'); git('checkout', PRE, '--', '.');
mkdirSync(join(scratch, 'convex/authority'), { recursive: true });
writeFileSync(join(scratch, 'convex/authority/migration.ts'), ''); writeFileSync(join(scratch, 'convex/authority/reads.ts'), '');
git('add', '-A'); git('commit', '-q', '-m', 'descendant of I1 restoring pre-I1 tree plus stub markers');
const stubChild = git('rev-parse', 'HEAD');
row('ATTACK descendant of I1 with pre-I1 tree + empty markers', stubChild, 'refuse');
row('tree object of that attack commit', git('rev-parse', stubChild + '^{tree}'), 'refuse');
// 4. git revert of every I1 commit (history descends, files deleted by the revert).
git('checkout', '-q', '--detach', I1);
try { git('revert', '--no-edit', '--no-commit', `${full('7299ee98')}^..${I1}`); git('commit', '-q', '-m', 'revert I1'); row('git revert of the whole I1 range', git('rev-parse', 'HEAD'), 'refuse'); } catch (e) { rows.push({ name: 'git revert of the whole I1 range', floor: 'revert conflicted: ' + String(e.stderr ?? e.message).split('\n')[0], expect: 'refuse' }); git('revert', '--abort'); }
// 5. Shallow clone (typical CI): the floor object is absent.
const shallow = scratch + '-shallow'; rmSync(shallow, { recursive: true, force: true });
execFileSync('git', ['clone', '-q', '--depth', '1', '--no-checkout', 'file://' + source, '-b', 'wip/i1-authority', shallow]);
row('shallow clone, target = its own tip', gitIn(shallow)('rev-parse', 'HEAD'), 'accept ideally; refuse is fail-closed', shallow);
// 6. Clone where the pinned commit is not reachable (I1 branch squashed then deleted).
const noPin = scratch + '-nopin'; rmSync(noPin, { recursive: true, force: true });
execFileSync('git', ['init', '-q', noPin]); execFileSync('git', ['fetch', '-q', scratch, 's:s'], { cwd: noPin });
row('clone holding only the squashed main', squash, 'refuse (fail closed)', noPin);
console.log(JSON.stringify(rows, null, 2));
const accepted = rows.filter(r => r.floor === true).map(r => r.name);
console.log('ACCEPTED:', accepted.join('; '));
console.log('FOOLED BY:', rows.filter(r => /^refuse/.test(r.expect) && r.floor === true).map(r => r.name).join('; ') || 'none');
rmSync(shallow, { recursive: true, force: true }); rmSync(noPin, { recursive: true, force: true });
