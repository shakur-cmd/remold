// Screenshots of the field order, retire and restore UI in Settings and of retire and
// archive proposals with their impact on Suggestions, against an isolated local Convex
// backend (ops/authority/local.mjs) with synthetic data only. Based on Job C's harness:
// only src/lib/identity is swapped for a locally signed JWT, and the browser refuses
// every request that is not to localhost.
// PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core CHROMIUM=/usr/bin/google-chrome node evidence/2026-10-03-campaigns/G/screenshot.mjs
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
  const orgId = await owner.mutation(anyApi.orgs.create, { name: 'Northwind Events' });
  const venueId = await owner.mutation(anyApi.objects.create, { orgId, key: 'venue', label: 'Venue', labelPlural: 'Venues' });
  for (const field of [{ key: 'city', label: 'City', type: 'text' }, { key: 'capacity', label: 'Capacity', type: 'number' }, { key: 'kind', label: 'Kind', type: 'select', options: [{ id: 'hall', label: 'Hall' }, { id: 'bar', label: 'Bar' }, { id: 'outdoor', label: 'Outdoor' }] }, { key: 'notes', label: 'Notes', type: 'text', indexed: false }, { key: 'fax', label: 'Fax', type: 'text' }]) await owner.mutation(anyApi.fields.create, { orgId, objectId: venueId, ...field });
  const workshopId = await owner.mutation(anyApi.objects.create, { orgId, key: 'workshop', label: 'Workshop', labelPlural: 'Workshops' });
  const fieldsOf = async (objectId) => Object.fromEntries((await owner.query(anyApi.fields.list, { orgId, objectId })).map(f => [f.key, f]));
  const v = await fieldsOf(venueId), w = await fieldsOf(workshopId);
  for (const [name, city, capacity] of [['Old Hall', 'Leeds', 300], ['The Yard', 'York', 120], ['Riverside', null, 80]]) await owner.mutation(anyApi.records.create, { orgId, objectId: venueId, values: { [v.name._id]: name, ...(city ? { [v.city._id]: city } : {}), [v.capacity._id]: capacity } });
  for (const name of ['Intro to pottery', 'Team offsite']) await owner.mutation(anyApi.records.create, { orgId, objectId: workshopId, values: { [w.name._id]: name } });
  // A person's own changes: Venues first in the navigation, fields reordered, Fax retired.
  const objects = await owner.query(anyApi.objects.list, { orgId });
  await owner.mutation(anyApi.objects.reorder, { orgId, objectIds: [venueId, ...objects.filter(o => o._id !== venueId).map(o => o._id)] });
  await owner.mutation(anyApi.fields.reorder, { orgId, objectId: venueId, fieldIds: [v.name._id, v.city._id, v.kind._id, v.capacity._id, v.notes._id, v.fax._id] });
  await owner.mutation(anyApi.fields.retire, { orgId, fieldId: v.fax._id });
  // An agent proposes retiring a field and archiving an object.
  const agent = await owner.action(anyApi.agents.create, { orgId, name: 'Research agent', role: 'admin' });
  const propose = async body => { const response = await fetch(site + '/api/v1/shape/proposals', { method: 'POST', headers: { authorization: `Bearer ${agent.key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }); const json = await response.json(); if (response.status !== 201) throw new Error(JSON.stringify(json)); return json.proposal; };
  await propose({ kind: 'retireField', object: 'venue', field: 'city', reason: 'City is now part of the address on each booking, so this copy drifts out of date.' });
  await propose({ kind: 'archiveObject', object: 'workshop', reason: 'No workshop has been added or changed since spring; it clutters the navigation.' });
  await propose({ kind: 'reorderOptions', object: 'venue', field: 'kind', order: ['outdoor', 'hall', 'bar'], reason: 'Most bookings this season are outdoor.' });
  const refused = await fetch(site + '/api/v1/shape/proposals', { method: 'POST', headers: { authorization: `Bearer ${agent.key}`, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'retireField', object: 'person', field: 'email', reason: 'unused' }) });
  console.log('agent proposes retiring person.email:', refused.status, JSON.stringify(await refused.json()));

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
    await page.goto(`http://localhost:5198/o/${orgId}/settings`);
    const card = page.locator('[data-slot="card"]').filter({ hasText: 'Objects and fields' });
    await card.getByRole('button', { name: 'Restore' }).waitFor({ timeout: 60000 }).catch(async error => { await page.screenshot({ path: join(scratch, 'debug.png') }); console.log('debug', join(scratch, 'debug.png'), blocked.join(' ')); throw error; });
    await card.getByRole('button', { name: 'Order options' }).click();
    await card.getByLabel('Field label').fill('Directions');
    await card.screenshot({ path: join(here, 'settings-fields.png') });
    // Moving Capacity up a place through the arrow button, then reading the order back.
    await card.getByRole('button', { name: 'Move Capacity up' }).click();
    await page.waitForTimeout(800);
    console.log('after clicking Move Capacity up:', (await owner.query(anyApi.objects.get, { orgId, objectId: venueId })).fields.map(f => f.key).join(', '));
    // The retire confirmation names the impact before anything changes.
    page.once('dialog', async dialog => { console.log('retire confirm text:', JSON.stringify(dialog.message())); await dialog.dismiss(); });
    await card.locator('li').filter({ hasText: 'Capacity' }).getByRole('button', { name: 'Retire' }).click();
    await page.waitForTimeout(800);
    await card.getByRole('button', { name: 'Restore' }).click();
    await page.waitForTimeout(800);
    console.log('after clicking Restore, live fields:', (await owner.query(anyApi.objects.get, { orgId, objectId: venueId })).fields.map(f => f.key).join(', '));
    await page.goto(`http://localhost:5198/o/${orgId}/suggestions`);
    await page.getByText('Retire field City on Venue').waitFor({ timeout: 60000 });
    // Each retire or archive card loads its own impact preview.
    await page.getByText('What this touches').nth(1).waitFor({ timeout: 60000 });
    await page.screenshot({ path: join(here, 'suggestions-retire-archive-impact.png'), fullPage: true });
    await page.getByText('Archive object Workshop').locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]').getByRole('button', { name: 'Apply' }).click();
    await page.getByText('Archive object Workshop').waitFor({ state: 'detached' });
    await page.screenshot({ path: join(here, 'after-archive-nav.png'), fullPage: true });
    console.log('nav links after archive:', (await page.locator('nav a').allInnerTexts()).join(' | '));
    console.log('non-local requests blocked:', blocked.length ? blocked.join(' ') : 'none');
  } finally { await browser.close(); await server.close(); }
  return {};
});
