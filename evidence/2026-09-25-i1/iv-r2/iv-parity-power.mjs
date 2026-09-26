// How discriminating is the D6 parity guard? Reuses the guard's own operation table and body
// extraction (read from h0-parity.test.ts) and asks: which single production test, mapped to
// every group, would the guard accept? Usage: node evidence/2026-09-25-i1/iv-r2/iv-parity-power.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const root = process.cwd(), guard = readFileSync(join(root, 'ops/authority/h0-parity.test.ts'), 'utf8');
const operations = eval(guard.slice(guard.indexOf('const operations'), guard.indexOf('];', guard.indexOf('const operations')) + 2).replace(/^const operations: \[string, RegExp, RegExp\]\[\] = /, ''));
const parity = JSON.parse(readFileSync(join(root, 'ops/authority/h0-parity.json'), 'utf8'));
const replay = readFileSync(join(root, 'proofs/contract/replay.mjs'), 'utf8');
const production = readdirSync(join(root, 'ops/authority')).filter(f => /^service.*\.mjs$/.test(f) || (/\.test\.ts$/.test(f) && !/^(h0-parity|inventory)\./.test(f))).map(f => readFileSync(join(root, 'ops/authority', f), 'utf8')).join('\n');
function body(source, name) {
  const prefix = name.replace(/ (?:false|true|provisional|final|sweep|expiry|failure)(?= |$).*$/, '').slice(0, 40);
  const found = [...source.matchAll(/\b(?:test|it)\((['`])/g)].map(m => ({ at: m.index, text: m.index + m[0].length }));
  const starts = found.map(m => m.at), matches = found.filter(m => source.startsWith(prefix, m.text)).map(m => m.at);
  if (matches.length !== 1) return null;
  const start = matches[0], next = starts.find(i => i > start) ?? source.length, close = /\n\s*\}\);/g; close.lastIndex = start; const end = close.exec(source)?.index ?? next;
  return source.slice(start, Math.min(end, next));
}
const names = [...production.matchAll(/\b(?:test|it)\((['`])([^'`]{10,})\1/g)].map(m => m[2]);
const passes = (groupBody, covered) => operations.every(([, inH0, inProd]) => !inH0.test(groupBody) || inProd.test(covered));
const groups = parity.map(r => ({ h0: r.h0, body: body(replay, r.h0), ops: operations.filter(([, inH0]) => inH0.test(body(replay, r.h0))).map(([l]) => l) }));
const perTest = names.map(n => { const b = body(production, n); return b ? { test: n, accepts: groups.filter(g => passes(g.body, b)).length } : null; }).filter(Boolean).sort((a, b) => b.accepts - a.accepts);
const opsCount = groups.map(g => g.ops.length), noOps = groups.filter(g => g.ops.length === 0).map(g => g.h0);
console.log(JSON.stringify({ productionTests: perTest.length, groupsWithNoOperations: noOps, operationsPerGroup: { min: Math.min(...opsCount), max: Math.max(...opsCount) }, top5SingleTestAcceptance: perTest.slice(0, 5), singleTestsAcceptingAtLeastHalf: perTest.filter(t => t.accepts >= 22).length }, null, 2));
