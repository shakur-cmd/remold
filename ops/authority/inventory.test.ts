import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import inventory from './inventory.json';

const root = process.cwd();
const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)]);
const sourceInventory = () => {
  const rows: { id: string; kind: string; visibility: string; writes: boolean }[] = [];
  for (const file of walk(join(root, 'convex')).filter(file => file.endsWith('.ts') && !file.includes('/_generated/') && !file.endsWith('.test.ts'))) {
    const source = readFileSync(file, 'utf8'), module = relative(join(root, 'convex'), file).replace(/\.ts$/, '');
    for (const match of source.matchAll(/export const (\w+)\s*=\s*(query|mutation|action|internalQuery|internalMutation|internalAction|httpAction)\s*\(/g)) {
      const [, name, declared] = match, kind = declared.replace('internal', '').toLowerCase();
      rows.push({ id: `${module}:${name}`, kind, visibility: declared === 'httpAction' ? 'http' : declared.startsWith('internal') ? 'internal' : 'public', writes: /mutation|action/i.test(declared) });
    }
  }
  return rows;
};
const fixed = [
  ['HTTP GET /api/v1/*', 'route', 'http', false], ['HTTP POST /api/v1/*', 'route', 'http', true], ['HTTP POST /api/integrations/v1/*', 'route', 'http', true],
  ['scheduled integrations/lifecycle:expire', 'scheduled', 'scheduled', true], ['scheduled integrations/lifecycle:sweep', 'scheduled', 'scheduled', true], ['scheduled integrations/safety:send', 'scheduled', 'scheduled', true], ['scheduled integrations/safety:unknown', 'scheduled', 'scheduled', true], ['scheduled telemetry:record', 'scheduled', 'scheduled', true], ['cron REST telemetry probe', 'cron', 'cron', true], ['cron Expire operational metrics', 'cron', 'cron', true],
] as const;

describe('authority inventory', () => {
  test('lists every registered function, HTTP surface, cron and scheduled target', async () => {
    process.env.WORKOS_CLIENT_ID ??= 'client_inventory_only';
    const modules = walk(join(root, 'convex')).filter(file => file.endsWith('.ts') && !file.includes('/_generated/') && !file.endsWith('.test.ts') && !file.endsWith('convex.config.ts'));
    await Promise.all(modules.map(file => import(file)));
    const expected = [...sourceInventory(), ...fixed.map(([id, kind, visibility, writes]) => ({ id, kind, visibility, writes }))].sort((a, b) => a.id.localeCompare(b.id));
    const actual = inventory.map(entry => ({ id: entry.id, kind: entry.kind, visibility: entry.visibility, writes: entry.writes })).sort((a, b) => a.id.localeCompare(b.id));
    expect(actual).toEqual(expected);
    const http = readFileSync(join(root, 'convex/http.ts'), 'utf8'), integration = readFileSync(join(root, 'convex/integrations/http.ts'), 'utf8'), crons = readFileSync(join(root, 'convex/crons.ts'), 'utf8'), scheduled = walk(join(root, 'convex')).filter(file => file.endsWith('.ts')).map(file => readFileSync(file, 'utf8')).join('\n');
    expect(http).toContain('pathPrefix: "/api/v1/", method: "GET"'); expect(http).toContain('pathPrefix: "/api/v1/", method: "POST"'); expect(integration).toContain('const mutations');
    for (const name of ['integrations/lifecycle:expire', 'integrations/lifecycle:sweep', 'integrations/safety:send', 'integrations/safety:unknown']) expect(scheduled).toContain(name);
    expect(crons).toContain('REST telemetry probe'); expect(crons).toContain('Expire operational metrics');
  });

  test('uses only the declared evidence vocabulary and leaves unproven rows as GAP', () => {
    for (const entry of inventory) {
      expect(['public', 'internal', 'http', 'cron', 'scheduled']).toContain(entry.visibility);
      expect(['refused', 'reduction-only', 'settlement-allowed', 'not-a-write']).toContain(entry.readonly);
      expect(['projected', 'no-record-data', 'n/a']).toContain(entry.masks);
      expect(typeof entry.proof).toBe('string');
    }
  });
});
