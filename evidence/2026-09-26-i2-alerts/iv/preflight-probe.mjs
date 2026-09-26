import { execFileSync } from 'node:child_process';
const m = await import(process.cwd() + '/ops/release/release.mjs');
const notes = JSON.parse(execFileSync('git', ['show', 'a173192:ops/release/notes.json']));
const schemaAt = sha => m.digest(execFileSync('git', ['show', `${sha}:convex/schema.ts`]));
const manifest = { sha: 'a173192', schemaSha256: schemaAt('a173192'), release: notes };
const floor = m.authorityFloorCheck(process.cwd(), notes.rollbackTarget);
console.log(JSON.stringify({ notes, floor, schemaCandidate: manifest.schemaSha256, schemaTarget: schemaAt(notes.rollbackTarget), schemaBase: schemaAt('d66eb0b') }));
try { m.preflight(manifest, notes.rollbackTarget, schemaAt(notes.rollbackTarget), undefined, 'x', undefined, floor); } catch (e) { console.log('preflight refused:', e.message); }
