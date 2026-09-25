import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import parity from './h0-parity.json';

// `replay.mjs` builds these 43 names from literals and its small parameter sets.
// Keeping them explicit makes a removed frozen group fail this inventory check.
const frozen = parity.map(row => row.h0);
const authoritySources = readdirSync(join(process.cwd(), 'ops/authority'))
  .filter(file => /\.(mjs|test\.ts)$/.test(file))
  .map(file => readFileSync(join(process.cwd(), 'ops/authority', file), 'utf8')).join('\n');

test('every frozen H0 replay group has a named production test', () => {
  expect(frozen).toHaveLength(43);
  const replay = readFileSync(join(process.cwd(), 'proofs/contract/replay.mjs'), 'utf8');
  for (const row of parity) {
    if (row.h0.startsWith('Unresolved consumed attempt survives ')) {
      expect(replay).toContain("for (const path of ['sweep', 'expiry', 'failure'])");
      expect(replay).toContain("'Unresolved consumed attempt survives ' + path + ' and holds global exposure'");
    } else if (row.h0.startsWith('Settled-step ') || row.h0.startsWith('Old consumed fence ')) {
      expect(replay).toContain("for (const finality of ['provisional', 'final'])");
      expect(replay).toContain(row.h0.startsWith('Settled-step ') ? "'Settled-step ' + finality" : "'Old consumed fence for the same unresolved step still supports ' + finality");
    } else {
      expect(replay).toContain(row.h0.replace(/ (?:false|true|provisional|final)$/, ''));
    }
    expect(row.production.length).toBeGreaterThan(0);
    for (const name of row.production) expect(authoritySources).toContain("test('" + name + "'");
  }
});
