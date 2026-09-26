import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';
import inventory from './inventory.json';

const root = process.cwd();
const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)]);
const modules = () => walk(join(root, 'convex')).filter(file => file.endsWith('.ts') && !file.includes('/_generated/') && !file.endsWith('.test.ts') && !file.endsWith('test.helpers.ts') && !file.endsWith('test.setup.ts') && !file.endsWith('convex.config.ts'));
const route = (method: string, path: string, writes: boolean, principal = 'agent') => ({ id: `HTTP ${method} ${path}`, kind: 'route', visibility: 'http', writes, principal });

async function registeredFunctions() {
  process.env.WORKOS_CLIENT_ID ??= 'client_inventory_only';
  const rows: { id: string; kind: string; visibility: string; writes: boolean; principal: string }[] = [];
  for (const file of modules()) {
    const module = relative(join(root, 'convex'), file).replace(/\.ts$/, '');
    const exports = await import(pathToFileURL(file).href) as Record<string, any>;
    for (const [name, value] of Object.entries(exports)) {
      const kind = value?.isQuery ? 'query' : value?.isMutation ? 'mutation' : value?.isHttp ? 'httpaction' : value?.isAction ? 'action' : null;
      if (!kind) continue;
      const visibility = value.isHttp ? 'http' : value.isInternal ? 'internal' : 'public';
      rows.push({ id: `${module}:${name}`, kind, visibility, writes: kind !== 'query', principal: module === 'agentApi' ? 'agent' : module.startsWith('integrations/') ? 'adapter' : 'human' });
    }
  }
  return rows;
}

// Derives every agent REST route from the dispatch() branches themselves, so a new
// branch (including a sub-route under an existing path) must get an inventory row.
function agentRoutes(http: string) {
  const body = http.slice(http.indexOf('async function dispatch'), http.indexOf('async function responseFor'));
  const commandSets = [...body.matchAll(/const commands: Record<string, string> = \{([^}]*)\}/g)].map(m => [...m[1]!.matchAll(/(\w+):/g)].map(k => k[1]!));
  const routes: { method: string; path: string }[] = [];
  let block = '', handled = 0;
  for (const line of body.split('\n')) {
    if (/^  \}\s*$/.test(line)) { block = ''; continue; }
    const opened = /^\s*if \(path\[0\] === "(\w+)"[^{]*\{\s*$/.exec(line); if (opened) { block = line; continue; }
    if (!/\breturn\b/.test(line)) continue;
    if (/_probe/.test(line)) { routes.push({ method: 'GET', path: '/api/v1/_probe' }); handled++; continue; }
    if (!/return json\(/.test(line)) continue;
    const context = block + line, method = /request\.method === "(GET|POST)"/.exec(context)?.[1], first = /path\[0\] === "(\w+)"/.exec(context)?.[1], length = Number(/path\.length === (\d)/.exec(line)?.[1] ?? 1), third = /path\[2\] === "(\w+)"/.exec(line)?.[1];
    expect(method && first, 'unparsed dispatch branch: ' + line.trim()).toBeTruthy();
    handled++;
    if (/commands\[path\[2\]\]/.test(line)) { for (const name of commandSets.shift()!) routes.push({ method: method!, path: `/api/v1/${first}/:id/${name}` }); continue; }
    if (/commands\[path\[1\]\]/.test(line)) { for (const name of commandSets.shift()!) routes.push({ method: method!, path: `/api/v1/${first}/${name}` }); continue; }
    routes.push({ method: method!, path: `/api/v1/${first}` + (length >= 2 ? '/:id' : '') + (third ? `/${third}` : '') });
  }
  // Every return in dispatch() is either a parsed route or one of three known non-routes.
  const returns = [...body.matchAll(/\breturn\b/g)].length;
  expect(returns - 3, 'dispatch() has a return branch the route parser did not understand').toBe(handled);
  return routes;
}

function httpRoutes() {
  const http = readFileSync(join(root, 'convex/http.ts'), 'utf8');
  const integration = readFileSync(join(root, 'convex/integrations/http.ts'), 'utf8');
  const requireSource = (source: string, token: string) => expect(source, `missing route branch ${token}`).toContain(token);
  const agent = agentRoutes(http).map(({ method, path }) => route(method, path, method === 'POST'));
  for (const token of ['_probe', 'operations', 'authority', 'me', 'objects', 'records', 'search', 'today', 'suggestions', 'changes', 'inbox', 'editAgent', 'claimAgent', 'cancelAgent', 'grantAgent', 'revokeAgent', 'fireAgent']) requireSource(http, token);
  const mutationTable = /const mutations:[\s\S]*?= \{([\s\S]*?)\};/.exec(integration)?.[1] ?? '';
  const mutationNames = [...mutationTable.matchAll(/(?:^|,)\s*['"]?([a-z-]+)['"]?\s*:/g)].map(match => match[1]);
  const explicitNames = ['safety-resolve-unknown', 'lookup', 'callback', 'status'];
  expect(mutationNames).toEqual(['permit', 'consume', 'unknown', 'reconcile', 'fail', 'safety-begin', 'safety-complete', 'safety-receipt', 'resolve-unknown', 'bind', 'page']);
  for (const name of explicitNames) requireSource(integration, `name === '${name}'`);
  return [...agent, ...mutationNames.map(name => route('POST', `/api/integrations/v1/${name}`, true, 'adapter')), ...explicitNames.map(name => route('POST', `/api/integrations/v1/${name}`, name !== 'status', 'adapter'))];
}

function scheduled() {
  const source = modules().map(file => readFileSync(file, 'utf8')).join('\n');
  const targets = ['integrations/lifecycle:expire', 'integrations/lifecycle:sweep', 'integrations/safety:send', 'integrations/safety:unknown', 'telemetry:record', 'telemetry:purge'];
  // A target must occur on a scheduler call, or be the named `expiry` reference
  // supplied to dispatch's two scheduler calls. This catches a changed target
  // while deliberately excluding ordinary makeFunctionReference calls.
  for (const target of targets) expect(source).toContain(target.replace(':', target.startsWith('telemetry:') ? '.' : ':'));
  for (const target of ['integrations/lifecycle:expire', 'integrations/lifecycle:sweep', 'integrations/safety:send', 'integrations/safety:unknown', 'telemetry:record', 'telemetry:purge']) expect(targets).toContain(target);
  const crons = readFileSync(join(root, 'convex/crons.ts'), 'utf8');
  for (const name of ['REST telemetry probe', 'Expire operational metrics', 'Operator alerts']) expect(crons).toContain(`"${name}"`);
  return targets.map(id => ({ id: `scheduled ${id}`, kind: 'scheduled', visibility: 'scheduled', writes: true, principal: 'scheduler' })).concat(['REST telemetry probe', 'Expire operational metrics', 'Operator alerts'].map(name => ({ id: `cron ${name}`, kind: 'cron', visibility: 'cron', writes: true, principal: 'scheduler' })));
}

describe('authority inventory', () => {
  test('lists every registered function, concrete HTTP branch, cron and scheduled target', async () => {
    const expected = [...await registeredFunctions(), ...httpRoutes(), ...scheduled()].sort((a, b) => a.id.localeCompare(b.id));
    const actual = inventory.map(entry => ({ id: entry.id, kind: entry.kind, visibility: entry.visibility, writes: entry.writes, principal: entry.principal })).sort((a, b) => a.id.localeCompare(b.id));
    expect(actual).toEqual(expected);
  });

  test('uses declared evidence vocabulary, proof strings, and reports inventory gaps', () => {
    const sources = [...walk(join(root, 'ops/authority')).filter(file => /\.(mjs|ts)$/.test(file)), ...walk(join(root, 'convex')).filter(file => file.endsWith('.test.ts'))].map(file => readFileSync(file, 'utf8')).join('\n');
    let gaps = 0;
    const routeSources = ['convex/http.ts', 'convex/integrations/http.ts', 'convex/telemetryHttp.ts'].map(file => readFileSync(join(root, file), 'utf8')).join('\n');
    for (const entry of inventory) {
      expect(['public', 'internal', 'http', 'cron', 'scheduled']).toContain(entry.visibility);
      expect(['human', 'agent', 'adapter', 'operator', 'scheduler', 'none']).toContain(entry.principal);
      expect(['refused', 'reduction-only', 'settlement-allowed', 'not-a-write', 'outside-workspace', 'operator-override']).toContain(entry.readonly);
      expect(['projected', 'no-record-data', 'n/a']).toContain(entry.masks);
      if (entry.proof === 'GAP') gaps++;
      else if (entry.proof.startsWith('operator-only:')) {
        // Operator-only means no client can reach it: internal, and never named by an HTTP route table.
        expect(['internal', 'cron', 'scheduled'], entry.id).toContain(entry.visibility);
        const name = entry.id.replace(/^(cron|scheduled) /, '');
        expect(routeSources, entry.id).not.toContain(name);
      } else expect(sources, entry.id).toContain(entry.proof);
    }
    console.log(`authority inventory GAP rows: ${gaps}`);
  });
});
