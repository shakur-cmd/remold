// Screenshot of agent shape proposals on the Suggestions page, against an isolated
// local Convex backend (ops/authority/local.mjs) with synthetic data only.
// Sign-in normally goes through WorkOS; here only src/lib/identity is swapped for a
// locally signed JWT, and the browser refuses every request that is not to localhost.
// Needs playwright-core: PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core node evidence/2026-10-03-campaigns/C/screenshot.mjs
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
const executablePath = process.env.CHROMIUM ?? join(process.env.HOME, 'Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');

await withAuthority(async ({ scratch, client, token, url, site }) => {
  const owner = client('shot-owner', { name: 'Sam Rivera' });
  await owner.mutation(anyApi.users.store, {});
  const orgId = await owner.mutation(anyApi.orgs.create, { name: 'Northwind Events' });
  const agent = await owner.action(anyApi.agents.create, { orgId, name: 'Research agent', role: 'admin' });
  const propose = async body => { const response = await fetch(site + '/api/v1/shape/proposals', { method: 'POST', headers: { authorization: `Bearer ${agent.key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }); const json = await response.json(); if (response.status !== 201) throw new Error(JSON.stringify(json)); return json.proposal; };
  await propose({ kind: 'addField', object: 'opportunity', key: 'budget', label: 'Budget', type: 'number', reason: 'Three of this week\'s leads gave a budget in their first email; I have nowhere to keep it.' });
  await propose({ kind: 'addObject', key: 'venue', label: 'Venue', labelPlural: 'Venues', fields: [{ key: 'capacity', label: 'Capacity', type: 'number' }, { key: 'kind', label: 'Kind', type: 'select', options: [{ id: 'hall', label: 'Hall' }, { id: 'bar', label: 'Bar' }, { id: 'outdoor', label: 'Outdoor' }] }, { key: 'owner', label: 'Owner', type: 'lookup', target: 'company' }], reason: 'You book the same venues again and again; tracking them lets me suggest one when a deal comes in.' });
  await propose({ kind: 'addOptions', object: 'opportunity', field: 'stage', options: [...['new', 'contacted', 'qualified', 'proposal', 'won', 'lost'].map(id => ({ id, label: id[0].toUpperCase() + id.slice(1) })), { id: 'onHold', label: 'On hold' }], reason: 'Two deals are waiting on the client\'s board vote and do not fit any stage.' });
  // A proposal made stale by a person's own change, applied so it shows under "Could not apply".
  const stale = await propose({ kind: 'addField', object: 'company', key: 'industry', label: 'Industry', type: 'text', reason: 'Useful for segmenting outreach.' });
  const company = (await owner.query(anyApi.objects.list, { orgId })).find(o => o.key === 'company');
  await owner.mutation(anyApi.fields.create, { orgId, objectId: company._id, key: 'industry', label: 'Industry', type: 'select', options: [{ id: 'venues', label: 'Venues' }] });
  console.log('stale apply:', JSON.stringify(await owner.mutation(anyApi.shapeSuggestions.apply, { orgId, id: stale.id })));

  const identity = join(scratch, 'identity.tsx');
  writeFileSync(identity, `import type { ReactNode } from "react";
import { ConvexProviderWithAuth, type ConvexReactClient } from "convex/react";
const token = (window as any).__REMOLD_TOKEN as string;
// One stable object: the provider re-authenticates whenever fetchAccessToken changes identity.
const auth = { isLoading: false, isAuthenticated: true, fetchAccessToken: async () => token };
const useAuth = () => auth;
export function IdentityProvider({ client, children }: { client: ConvexReactClient; children: ReactNode }) { return <ConvexProviderWithAuth client={client} useAuth={useAuth}>{children}</ConvexProviderWithAuth>; }
export function useIdentity() { return { isLoading: false, user: { name: "Sam Rivera", email: "sam@example.invalid", imageUrl: undefined }, signIn() {}, signUp() {}, signOut() {} }; }
`);
  process.env.VITE_CONVEX_URL = url;
  const server = await createServer({ configFile: false, root, envDir: scratch, logLevel: 'warn', plugins: [react(), tailwindcss()], resolve: { alias: [{ find: /^(@|\.)\/lib\/identity$/, replacement: identity }, { find: '@', replacement: join(root, 'src') }] }, server: { port: 5199, strictPort: true, fs: { allow: [root, scratch] } } });
  await server.listen();
  const browser = await chromium.launch({ executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const blocked = [];
    await page.route('**/*', route => { const host = new URL(route.request().url()).hostname; if (host === 'localhost' || host === '127.0.0.1') return route.continue(); blocked.push(route.request().url()); return route.abort(); });
    await page.addInitScript(t => { window.__REMOLD_TOKEN = t; }, token('shot-owner', { name: 'Sam Rivera' }));
    page.on('console', m => { if (m.type() === 'error') console.log('page error:', m.text().slice(0, 300)); });
    await page.goto(`http://localhost:5199/o/${orgId}/suggestions`);
    await page.getByText('Add field Budget (number) to Opportunity').waitFor({ timeout: 60000 }).catch(async error => { await page.screenshot({ path: join(scratch, 'debug.png') }); console.log('debug screenshot', join(scratch, 'debug.png'), 'blocked', blocked.join(' ')); throw error; });
    await page.getByText('Could not apply').waitFor();
    await page.screenshot({ path: join(here, 'suggestions-shape-proposals.png'), fullPage: true });
    // Applying from the page: the card leaves, and the new field is in the object.
    await page.getByText('Add field Budget (number) to Opportunity').locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]').getByRole('button', { name: 'Apply' }).click();
    await page.getByText('Add field Budget (number) to Opportunity').waitFor({ state: 'detached' });
    const opportunity = (await owner.query(anyApi.objects.list, { orgId })).find(o => o.key === 'opportunity');
    const fields = (await owner.query(anyApi.objects.get, { orgId, objectId: opportunity._id })).fields.map(f => f.key);
    console.log('after clicking Apply, opportunity fields:', fields.join(', '));
    await page.screenshot({ path: join(here, 'suggestions-after-apply.png'), fullPage: true });
    console.log('non-local requests blocked:', blocked.length ? blocked.join(' ') : 'none');
  } finally { await browser.close(); await server.close(); }
  return {};
});
