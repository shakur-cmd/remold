import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import parity from './h0-parity.json';

// Each H0 group must point at production tests that exercise the same operations
// the group exercises. A row pointing at an unrelated test fails, because that
// test's body does not perform the group's operations (IV defect D6).
const root = process.cwd();
const replay = readFileSync(join(root, 'proofs/contract/replay.mjs'), 'utf8');
// SERVICE replays and convex-test unit tests both run the production convex/ code.
const production = readdirSync(join(root, 'ops/authority')).filter(file => /^service.*\.mjs$/.test(file) || (/\.test\.ts$/.test(file) && !/^(h0-parity|inventory)\./.test(file))).map(file => readFileSync(join(root, 'ops/authority', file), 'utf8')).join('\n');

// Body of the test whose (possibly templated) source name starts with the given text.
function body(source: string, name: string) {
  const prefix = name.replace(/ (?:false|true|provisional|final|sweep|expiry|failure)(?= |$).*$/, '').slice(0, 40);
  const found = [...source.matchAll(/\b(?:test|it)\((['`])/g)].map(m => ({ at: m.index!, text: m.index! + m[0].length }));
  const starts = found.map(m => m.at), matches = found.filter(m => source.startsWith(prefix, m.text)).map(m => m.at);
  expect(matches, `exactly one test source starts with "${prefix}"`).toHaveLength(1);
  // A test ends at its own closing "});" line, so setup code that follows it is not credited to it.
  const start = matches[0]!, next = starts.find(i => i > start) ?? source.length, close = /\n\s*\}\);/g;
  close.lastIndex = start; const end = close.exec(source)?.index ?? next;
  return source.slice(start, Math.min(end, next));
}

// H0 harness operation -> how the production suites perform the same operation.
// Granting and approving are left out: H0 routes work through agents, while
// production tests often use a human proposer who needs neither.
const operations: [string, RegExp, RegExp][] = [
  ['fire an actor', /\bfire\(|\('revoke'/, /agents\.revoke|authority\/fire|fireAgent/],
  ['attempt an out-of-scope grant', /reject\('grant'/, /authority\/grant|grants'\]\.grant|\.issue\(/],
  ['revoke a grant', /call\('revokeGrant'/, /grants'\]\.revoke|authority\/revoke|revokeAgent/],
  ['record provider absence', /call\('resolveUnknown'/, /resolve-unknown|operatorResolveUnknown|absence\(/],
  ['mark outcome unknown', /call\('unknown'/, /'unknown'/],
  ['reconcile a provider result', /call\('reconcile'/, /'reconcile'/],
  ['fail an attempt', /call\('fail'/, /'fail'/],
  ['cancel', /call\('cancel'/, /cancel/i],
  ['page a traversal', /call\('page'/, /'page'/],
  ['provision', /call\('provision'/, /provision/],
  ['deliver a callback', /call\('callback'|inbound\(/, /'callback'/],
  ['bind', /call\('bind'/, /bind/],
  ['edit a payload', /call\('edit'/, /edit/i],
  ['set readonly', /readonly: true/, /readonly: true/],
  ['clear an anomaly', /clearAnomaly/, /clearAnomaly/],
  ['claim', /\bclaim\(|call\('claim'/, /claim|\.permit\(|\.start\(/],
  ['issue a permit', /\bpermit\(|call\('permit'/, /permit|\.start\(/],
  ['consume a permit', /\bconsume\(|call\('consume'/, /consume|\.start\(/],
];

// Every test body in the production suites, for measuring how specific a pattern is.
const allBodies = [...new Set([...production.matchAll(/\b(?:test|it)\((['`])([^'`]{10,})\1/g)].map(m => m[2]!))].map(name => {
  const prefix = name.replace(/ (?:false|true|provisional|final|sweep|expiry|failure)(?= |$).*$/, '').slice(0, 40);
  return [...production.matchAll(/\b(?:test|it)\((['`])/g)].filter(m => production.startsWith(prefix, m.index! + m[0].length)).length === 1 ? body(production, name) : null;
}).filter((b): b is string => b !== null);
// The shared operation table is coarse (claim, permit, consume...), so each row also
// names the group's own check: a pattern that must appear in a mapped test and in
// at most MAX_SHARED production tests, so it cannot be a generic step (IV round 2).
const MAX_SHARED = 6;
const accepts = (row: typeof parity[number], covered: string) => {
  const h0 = body(replay, row.h0);
  return operations.every(([, inH0, inProduction]) => !inH0.test(h0) || inProduction.test(covered)) && new RegExp(row.exercises).test(covered);
};

test('every frozen H0 replay group maps to production tests that exercise its operations', () => {
  expect(parity).toHaveLength(43);
  expect(new Set(parity.map(row => row.h0)).size).toBe(43);
  const gaps: string[] = [];
  for (const row of parity) {
    const h0 = body(replay, row.h0);
    expect(row.production.length, row.h0).toBeGreaterThan(0);
    const covered = row.production.map(name => body(production, name)).join('\n');
    const missing = operations.filter(([, inH0, inProduction]) => inH0.test(h0) && !inProduction.test(covered)).map(([label]) => label);
    if (missing.length) gaps.push(`${row.h0}: mapped tests never ${missing.join(', ')}`);
    const own = new RegExp(row.exercises), shared = allBodies.filter(b => own.test(b)).length;
    if (!own.test(covered)) gaps.push(`${row.h0}: no mapped test does its own check /${row.exercises}/`);
    if (shared > MAX_SHARED) gaps.push(`${row.h0}: /${row.exercises}/ appears in ${shared} tests, too generic to identify this group`);
  }
  expect(gaps).toEqual([]);
});

test('no single production test can stand in for more than five groups', () => {
  // The largest multi-group production test covers five groups by design (H0#15 H0#24 H0#25 H0#36 H0#37).
  const widest = Math.max(...allBodies.map(b => parity.filter(row => accepts(row, b)).length));
  expect(allBodies.length).toBeGreaterThan(100);
  expect(widest).toBeLessThanOrEqual(5);
});

test('the guard rejects a map that points every group at one unrelated test', () => {
  const unrelated = 'Real JWT verification derives human identity and rejects invalid audience and expired tokens';
  const covered = body(production, unrelated);
  expect(parity.filter(row => !accepts(row, covered))).toHaveLength(43);
});
