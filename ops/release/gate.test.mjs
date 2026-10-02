// The first-customer gate is only as good as its rows: a done row must name tests that exist,
// a pending row must name its owner, and a row needing Shakur stays pending until he approves it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.name === 'node_modules' || e.name.startsWith('.') ? [] : e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
const titles = new Set(['convex', 'src', 'ops'].flatMap(d => walk(join(root, d))).filter(f => /\.test\.(ts|tsx|mjs)$/.test(f)).flatMap(f => [...readFileSync(f, 'utf8').matchAll(/\b(?:it|test)(?:\.each\([^)]*\))?\(\s*(["'`])((?:(?!\1).)+)\1/g)].map(m => m[2])));
const rows = html => [...html.matchAll(/<tr (data-[^>]*)>/g)].map(m => Object.fromEntries([...m[1].matchAll(/data-([a-z]+)="([^"]*)"/g)].map(a => [a[1], a[2]])));

export function gateProblems(html) {
  const problems = [];
  for (const row of rows(html)) {
    if (!['done', 'pending'].includes(row.state)) problems.push(`row with state "${row.state}"`);
    if (row.state === 'pending' && !row.owner) problems.push('a pending row names no owner');
    if (row.requires === 'shakur' && row.state === 'done' && !/^\d{4}-\d{2}-\d{2}$/.test(row.approved ?? '')) problems.push('a row needing Shakur is done without an approval date');
    if (row.state === 'done') {
      const cited = (row.tests ?? '').split('|').filter(Boolean);
      if (!cited.length) problems.push('a done row cites no tests');
      for (const name of cited) if (!titles.has(name)) problems.push(`cited test not found: ${name}`);
    }
  }
  return problems;
}

const gate = readFileSync(join(root, 'docs/first-customer-gate.html'), 'utf8');
test('the first-customer gate rows are each backed by tests or owned', () => {
  assert.ok(rows(gate).length >= 15);
  assert.deepEqual(gateProblems(gate), []);
});
test('the gate keeps the lines live billing and large workspaces depend on', () => {
  const text = gate.replace(/<[^>]+>/g, ' ');
  assert.match(text, /Cancel the Stripe subscription when a workspace is deleted, before live billing/);
  assert.match(text, /export up to 64 MB per file; larger workspaces by request/);
  assert.ok(rows(gate).some(row => row.id === 'stripe-cancel'), 'the Stripe cancellation row is a tracked gate row');
});
test('marking a pending row done without tests, or a Shakur row without approval, is caught', () => {
  assert.match(gateProblems(gate.replace('data-state="pending" data-owner="M10 follow-up: onboarding"', 'data-state="done"')).join(), /cites no tests/);
  assert.match(gateProblems(gate.replace('data-state="pending" data-owner="Shakur" data-requires="shakur"><td>A price', 'data-state="done" data-requires="shakur" data-tests="opens a subscription Checkout for the owner with the price from the environment"><td>A price')).join(), /approval date/);
  assert.match(gateProblems(gate.replace('data-tests="writes definitions', 'data-tests="no such test|writes definitions')).join(), /not found: no such test/);
});
