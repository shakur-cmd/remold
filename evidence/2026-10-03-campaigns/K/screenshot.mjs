// Screenshots of a blueprint proposal card on Suggestions and of the template picker and its
// review dialog in Settings, against an isolated local Convex backend (ops/authority/local.mjs)
// with synthetic data only. Same harness as Job G: only src/lib/identity is swapped for a
// locally signed JWT, and the browser refuses every request that is not to localhost.
// PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core CHROMIUM=/usr/bin/google-chrome node evidence/2026-10-03-campaigns/K/screenshot.mjs
import { writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { anyApi } from 'convex/server';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { withAuthority } from '../../../ops/authority/local.mjs';

const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '../../..');
const { chromium } = await import(pathToFileURL(join(process.env.PLAYWRIGHT_CORE, 'index.mjs')).href);
const executablePath = process.env.CHROMIUM ?? '/usr/bin/google-chrome';

await withAuthority(async ({ scratch, client, token, url, site }) => {
  const owner = client('shot-owner', { name: 'Sam Rivera' });
  await owner.mutation(anyApi.users.store, {});
  const orgId = await owner.mutation(anyApi.orgs.create, { name: 'Fixit Repairs' });
  await owner.mutation(anyApi.objects.create, { orgId, key: 'workshop', label: 'Workshop', labelPlural: 'Workshops' });
  const agent = await owner.action(anyApi.agents.create, { orgId, name: 'Setup agent', role: 'admin' });
  const call = async (method, path, body) => { const response = await fetch(site + '/api/v1' + path, { method, headers: { authorization: `Bearer ${agent.key}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, json: await response.json() }; };
  // The agent lists the built-in blueprints, adapts nothing, and proposes a repair-shop one of its own.
  console.log('GET /blueprints:', (await call('GET', '/blueprints')).json.blueprints.map((b) => b.id).join(', '));
  const blueprint = { version: 1, name: 'Repair shop', description: 'Jobs and quotes for a phone and laptop repair counter.', changes: [
    { kind: 'addObject', key: 'repairJob', label: 'Repair Job', labelPlural: 'Repair Jobs', fields: [
      { key: 'customer', label: 'Customer', type: 'lookup', target: 'person' }, { key: 'quote', label: 'Quote', type: 'lookup', target: 'quote' },
      { key: 'device', label: 'Device', type: 'text' }, { key: 'status', label: 'Status', type: 'select', options: [{ id: 'new', label: 'New' }, { id: 'diagnosed', label: 'Diagnosed' }, { id: 'waitingParts', label: 'Waiting for parts' }, { id: 'ready', label: 'Ready for pickup' }] },
      { key: 'droppedOff', label: 'Dropped off', type: 'date', withTime: true }, { key: 'price', label: 'Price', type: 'number' }, { key: 'fault', label: 'Fault', type: 'text', indexed: false } ] },
    { kind: 'addObject', key: 'quote', label: 'Quote', labelPlural: 'Quotes', fields: [{ key: 'job', label: 'Job', type: 'lookup', target: 'repairJob' }, { key: 'amount', label: 'Amount', type: 'number' }, { key: 'accepted', label: 'Accepted', type: 'boolean' }] },
    { kind: 'addOptions', object: 'opportunity', field: 'stage', options: [{ id: 'diagnosed', label: 'Diagnosed' }, { id: 'partsOrdered', label: 'Parts ordered' }] },
    { kind: 'retireField', object: 'company', field: 'street' },
    { kind: 'archiveObject', object: 'workshop' },
  ], records: [{ object: 'quote', values: { name: 'Screen swap quote', amount: 129 } }, { object: 'repairJob', values: { name: 'Cracked screen', quote: 'Screen swap quote', device: 'Phone', status: 'new' } }] };
  const made = await call('POST', '/shape/proposals', { kind: 'blueprint', reason: 'You asked to make this a repair-shop CRM. One change, so you can review it as a whole.', blueprint });
  console.log('agent proposes blueprint:', made.status, made.json.proposal?.summary ?? JSON.stringify(made.json));
  const refused = await call('POST', '/shape/proposals', { kind: 'blueprint', reason: 'x', blueprint: { ...blueprint, changes: [blueprint.changes[0]] } });
  console.log('agent proposes blueprint with a dangling reference:', refused.status, JSON.stringify(refused.json));

  const identity = join(scratch, 'identity.tsx');
  writeFileSync(identity, `import type { ReactNode } from "react";
import { ConvexProviderWithAuth, type ConvexReactClient } from "convex/react";
const token = (window as any).__REMOLD_TOKEN as string;
const auth = { isLoading: false, isAuthenticated: true, fetchAccessToken: async () => token };
const useAuth = () => auth;
export function IdentityProvider({ client, children }: { client: ConvexReactClient; children: ReactNode }) { return <ConvexProviderWithAuth client={client} useAuth={useAuth}>{children}</ConvexProviderWithAuth>; }
export function useIdentity() { return { isLoading: false, user: { name: "Sam Rivera", email: "sam@example.invalid", imageUrl: undefined }, signIn() {}, signUp() {}, signOut() {} }; }
`);
  process.env.VITE_CONVEX_URL = url;
  const server = await createServer({ configFile: false, root, envDir: scratch, logLevel: 'warn', plugins: [react(), tailwindcss()], resolve: { alias: [{ find: /^(@|\.)\/lib\/identity$/, replacement: identity }, { find: '@', replacement: join(root, 'src') }] }, server: { port: 5198, strictPort: true, fs: { allow: [root, scratch] } } });
  await server.listen();
  const browser = await chromium.launch({ executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
    const blocked = [];
    await page.route('**/*', route => { const host = new URL(route.request().url()).hostname; if (host === 'localhost' || host === '127.0.0.1') return route.continue(); blocked.push(route.request().url()); return route.abort(); });
    await page.addInitScript(t => { window.__REMOLD_TOKEN = t; }, token('shot-owner', { name: 'Sam Rivera' }));
    page.on('console', m => { if (m.type() === 'error') console.log('page error:', m.text().slice(0, 300)); });
    await page.goto(`http://localhost:5198/o/${orgId}/suggestions`);
    const card = page.locator('div.rounded-lg').filter({ hasText: 'wants to reshape the workspace' });
    await card.getByText('Searchable and sortable slots after applying').waitFor({ timeout: 60000 }).catch(async error => { await page.screenshot({ path: join(scratch, 'debug.png') }); console.log('debug', join(scratch, 'debug.png'), blocked.join(' ')); throw error; });
    await card.getByText('what this touches').nth(1).waitFor({ timeout: 60000 });
    await card.getByLabel('Also add the starter records').click();
    await page.waitForTimeout(1500);
    await card.screenshot({ path: join(here, 'suggestions-blueprint-card.png') });
    await card.getByRole('button', { name: 'Apply all' }).click();
    await page.getByText('wants to reshape the workspace').waitFor({ state: 'detached', timeout: 60000 });
    const objects = await owner.query(anyApi.objects.list, { orgId });
    console.log('after Apply all, objects:', objects.map(o => o.key + (o.archived ? ' (archived)' : '')).join(', '));
    console.log('after Apply all, proposal status:', (await call('GET', '/shape/proposals?status=applied')).json.proposals.map(p => p.kind + ':' + p.status).join(', '));
    const job = objects.find(o => o.key === 'repairJob');
    console.log('starter records in Repair Jobs:', (await owner.query(anyApi.records.list, { orgId, objectId: job._id, paginationOpts: { numItems: 10, cursor: null } }).catch(e => ({ page: [], error: String(e).slice(0, 120) }))).page?.map(r => r.title).join(', '));

    await page.goto(`http://localhost:5198/o/${orgId}/settings`);
    const settings = page.locator('[data-slot="card"]').filter({ hasText: 'Start from a template' });
    await settings.getByText('Local retail or maker').waitFor({ timeout: 60000 });
    await settings.screenshot({ path: join(here, 'settings-template-picker.png') });
    const dialog = page.getByRole('dialog');
    await settings.getByText('Creator or coach').click();
    await dialog.getByText('Searchable and sortable slots after applying').waitFor({ timeout: 60000 });
    await dialog.screenshot({ path: join(here, 'settings-template-review.png') });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    // The repair shop already has a Quote object, so the Service template is refused before anything changes.
    await settings.getByText('Service business').click();
    await dialog.getByText('Cannot apply').waitFor({ timeout: 60000 });
    await dialog.screenshot({ path: join(here, 'settings-template-refused.png') });
    console.log('service template check text:', (await dialog.getByText('Cannot apply').allInnerTexts()).join(' | '));
    console.log('Apply all enabled on the refused template:', await dialog.getByRole('button', { name: 'Apply all' }).isEnabled());
    console.log('non-local requests blocked:', blocked.length ? blocked.join(' ') : 'none');
  } finally { await browser.close(); await server.close(); }
  return {};
});
