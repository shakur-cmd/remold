// Screenshots of agent object access on the Settings agents card, against an isolated
// local Convex backend (ops/authority/local.mjs) with synthetic data only.
// Sign-in normally goes through WorkOS; here only src/lib/identity is swapped for a
// locally signed JWT, and the browser refuses every request that is not to localhost.
// PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core CHROMIUM=/usr/bin/google-chrome node evidence/2026-10-03-campaigns/D/screenshot.mjs
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

await withAuthority(async ({ scratch, client, token, url, site }) => {
  const owner = client('shot-owner', { name: 'Sam Rivera' });
  await owner.mutation(anyApi.users.store, {});
  const orgId = await owner.mutation(anyApi.orgs.create, { name: 'Northwind Events' });
  const early = await owner.action(anyApi.agents.create, { orgId, name: 'Research agent' });
  const wide = await owner.action(anyApi.agents.create, { orgId, name: 'Ops agent', grants: [{ action: 'create', objectKey: 'task' }] });
  await owner.mutation(anyApi.agents.setReadAccess, { orgId, agentId: wide.agentId, readAllObjects: true, objectIds: [] });
  await owner.mutation(anyApi.agents.setSharedInbox, { orgId, agentId: early.agentId, enabled: true });
  // Objects added after both agents were made.
  await owner.mutation(anyApi.objects.create, { orgId, key: 'venue', label: 'Venue', labelPlural: 'Venues' });
  await owner.mutation(anyApi.objects.create, { orgId, key: 'bookingPage', label: 'Booking page', labelPlural: 'Booking pages' });
  const objects = async (key) => (await (await fetch(site + '/api/v1/objects', { headers: { authorization: `Bearer ${key}` } })).json()).map(o => o.key);
  console.log('Research agent reads before:', (await objects(early.key)).join(','));
  console.log('Ops agent reads (all objects):', (await objects(wide.key)).join(','));

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
  const server = await createServer({ configFile: false, root, envDir: scratch, logLevel: 'warn', plugins: [react(), tailwindcss()], resolve: { alias: [{ find: /^(@|\.)\/lib\/identity$/, replacement: identity }, { find: '@', replacement: join(root, 'src') }] }, server: { port: 5199, strictPort: true, fs: { allow: [root, scratch] } } });
  await server.listen();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const blocked = [];
    await page.route('**/*', route => { const host = new URL(route.request().url()).hostname; if (host === 'localhost' || host === '127.0.0.1') return route.continue(); blocked.push(route.request().url()); return route.abort(); });
    await page.addInitScript(t => { window.__REMOLD_TOKEN = t; }, token('shot-owner', { name: 'Sam Rivera' }));
    page.on('console', m => { if (m.type() === 'error') console.log('page error:', m.text().slice(0, 300)); });
    await page.goto(`http://localhost:5199/o/${orgId}/settings`);
    const card = page.locator('[data-slot="card"]', { hasText: 'Website intake key' }).first();
    await page.getByText('Cannot see: Venues, Booking pages').waitFor({ timeout: 60000 });
    await page.getByText('Shared inbox needs access to all objects.').waitFor();
    await card.screenshot({ path: join(here, 'agents-card.png') });
    // One click: the Research agent may now read Venues.
    await page.getByRole('button', { name: 'Let it read Venues' }).click();
    await page.getByText('Cannot see: Booking pages').waitFor();
    console.log('after Let it read Venues, Research agent reads:', (await objects(early.key)).join(','));
    await page.getByRole('button', { name: 'Access' }).first().click();
    await page.getByLabel('Research agent reads Booking pages').waitFor();
    await card.screenshot({ path: join(here, 'agents-card-access.png') });
    console.log('non-local requests blocked:', blocked.length ? blocked.join(' ') : 'none');
  } finally { await browser.close(); await server.close(); }
  return {};
});
