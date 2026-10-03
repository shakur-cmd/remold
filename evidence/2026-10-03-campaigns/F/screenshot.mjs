// Saved views in the app and over REST, against an isolated local Convex backend
// (ops/authority/local.mjs) with synthetic data only. Sign-in normally goes through
// WorkOS; here only src/lib/identity is swapped for a locally signed JWT, and the
// browser refuses every request that is not to localhost.
// PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core CHROMIUM=/path/to/chrome node evidence/2026-10-03-campaigns/F/screenshot.mjs
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
const day = d => Date.parse(`${d}T00:00:00Z`), iso = ms => new Date(ms).toISOString().slice(0, 10), DAY = 86400000;

await withAuthority(async ({ scratch, client, token, url, site }) => {
  const owner = client('shot-owner', { name: 'Sam Rivera' });
  await owner.mutation(anyApi.users.store, {});
  const orgId = await owner.mutation(anyApi.orgs.create, { name: 'Rivera Builders' });
  const objects = await owner.query(anyApi.objects.list, { orgId }), objectOf = key => objects.find(o => o.key === key);
  const fieldsOf = async key => Object.fromEntries((await owner.query(anyApi.objects.get, { orgId, objectId: objectOf(key)._id })).fields.map(f => [f.key, f]));
  const opp = objectOf('opportunity'), o = await fieldsOf('opportunity'), task = objectOf('task'), t = await fieldsOf('task');
  const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const deals = [['Kitchen remodel, Ortiz', 'proposal', 18500, 3], ['Deck rebuild, Chen', 'proposal', 9200, 9], ['Basement finish, Patel', 'qualified', 31000, 20], ['Roof repair, Gomez', 'contacted', 4800, 2], ['Bathroom refresh, Kim', 'proposal', 12700, -4], ['Garage addition, Novak', 'won', 46000, -10], ['Window replacement, Brooks', 'new', 7600, 14], ['Porch railing, Diaz', 'lost', 2100, -20]];
  for (const [name, stage, amount, close] of deals) await owner.mutation(anyApi.records.create, { orgId, objectId: opp._id, values: { [o.name._id]: name, [o.stage._id]: stage, [o.amount._id]: amount, [o.closeDate._id]: today + close * DAY } });
  for (const [title, due] of [['Call Ortiz about tile', -2], ['Send Chen revised quote', -1], ['Order lumber for Novak', 0], ['Site visit, Brooks', 3]]) await owner.mutation(anyApi.records.create, { orgId, objectId: task._id, values: { [t.title._id]: title, [t.dueDate._id]: today + due * DAY } });

  const quotes = await owner.mutation(anyApi.views.create, { orgId, objectId: opp._id, name: 'Quotes out', layout: 'table', columns: [o.amount._id, o.closeDate._id, o.stage._id], filters: [{ fieldId: o.stage._id, value: 'proposal' }], sort: { fieldId: o.amount._id, direction: 'desc' }, shared: true, pinned: true });
  const board = await owner.mutation(anyApi.views.create, { orgId, objectId: opp._id, name: 'Pipeline', layout: 'board', groupFieldId: o.stage._id, columns: [], filters: [], shared: true, pinned: true });
  await owner.mutation(anyApi.views.create, { orgId, objectId: opp._id, name: 'Big jobs', layout: 'table', columns: [o.amount._id, o.stage._id], filters: [], sort: { fieldId: o.amount._id, direction: 'desc' } });
  const overdue = await owner.mutation(anyApi.views.create, { orgId, objectId: task._id, name: 'Overdue', layout: 'table', columns: [t.dueDate._id, t.done._id], filters: [], range: { fieldId: t.dueDate._id, relative: 'overdue' }, shared: true });

  // Agents read and run views over REST, in the real Convex runtime (time zones included).
  const agent = await owner.action(anyApi.agents.create, { orgId, name: 'Ops agent', role: 'admin' });
  const call = async (method, path, body) => { const r = await fetch(site + path, { method, headers: { authorization: `Bearer ${agent.key}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, json: await r.json() }; };
  const listed = await call('GET', '/api/v1/views');
  console.log('GET /api/v1/views ->', listed.status, listed.json.views.map(v => `${v.object}:${v.name}`).join(', '));
  for (const tz of ['America/New_York', 'Asia/Tokyo']) { const ran = await call('GET', `/api/v1/views/${overdue}/records?tz=${encodeURIComponent(tz)}`); console.log(`GET /api/v1/views/<Overdue>/records?tz=${tz} ->`, ran.status, ran.json.records.map(r => r.title).join(' | ')); }
  const quoteRun = await call('GET', `/api/v1/views/${quotes}/records`);
  console.log('GET /api/v1/views/<Quotes out>/records ->', quoteRun.status, quoteRun.json.records.map(r => `${r.title} ${JSON.stringify(r.values)}`).join(' | '));
  console.log('bad tz ->', (await call('GET', `/api/v1/views/${overdue}/records?tz=Nowhere/Land`)).status);
  const proposed = await call('POST', '/api/v1/shape/proposals', { kind: 'addView', object: 'opportunity', name: 'Closing this week', layout: 'table', columns: ['amount', 'closeDate'], filters: [{ field: 'stage', value: 'Proposal' }], range: { field: 'closeDate', relative: 'next7' }, sort: { field: 'closeDate', direction: 'asc' }, pinned: true, reason: 'You ask me every Monday which quotes close this week; a view answers that at a glance.' });
  console.log('POST addView proposal ->', proposed.status, proposed.json.proposal?.summary);

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
  const server = await createServer({ configFile: false, root, envDir: scratch, logLevel: 'warn', plugins: [react(), tailwindcss()], resolve: { alias: [{ find: /^(@|\.)\/lib\/identity$/, replacement: identity }, { find: '@', replacement: join(root, 'src') }] }, server: { port: 5207, strictPort: true, fs: { allow: [root, scratch] } } });
  await server.listen();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const blocked = [];
    await page.route('**/*', route => { const host = new URL(route.request().url()).hostname; if (host === 'localhost' || host === '127.0.0.1') return route.continue(); blocked.push(route.request().url()); return route.abort(); });
    await page.addInitScript(tk => { window.__REMOLD_TOKEN = tk; }, token('shot-owner', { name: 'Sam Rivera' }));
    page.on('console', m => { if (m.type() === 'error') console.log('page error:', m.text().slice(0, 300)); });
    const shot = name => page.screenshot({ path: join(here, name) });

    // 1. The views bar on a saved table view, opened from its pinned menu link.
    await page.goto(`http://localhost:5207/o/${orgId}/opportunity`);
    await page.getByRole('link', { name: 'Quotes out' }).click();
    await page.getByText('Kitchen remodel, Ortiz').waitFor({ timeout: 60000 });
    await page.getByText('Roof repair, Gomez').waitFor({ state: 'detached' });
    console.log('Quotes out rows in the app:', (await page.locator('tbody tr').allInnerTexts()).map(r => r.split('\t')[0]).join(' | '));
    await shot('views-bar.png');

    // 2. A saved board view.
    await page.getByRole('button', { name: 'Pipeline', exact: true }).click();
    await page.getByRole('heading', { name: /^Proposal/ }).waitFor();
    console.log('board view url:', new URL(page.url()).search);
    await shot('saved-board-view.png');

    // 3. Saving the current list as a new shared, pinned view through the dialog.
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await page.getByRole('combobox', { name: 'Add filter' }).click();
    await page.getByRole('option', { name: 'Stage' }).click();
    await page.getByRole('combobox', { name: 'Stage value' }).click();
    await page.getByRole('option', { name: 'Qualified' }).click();
    await page.getByRole('button', { name: 'Save view' }).click();
    await page.getByLabel('Name').fill('Ready to quote');
    await page.getByText('Share with the workspace').click();
    await page.getByText('Pin in the menu').click();
    await shot('save-view-dialog.png');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('link', { name: 'Ready to quote' }).waitFor();
    const saved = (await owner.query(anyApi.views.list, { orgId })).find(v => v.name === 'Ready to quote');
    console.log('saved from the dialog:', JSON.stringify({ shared: saved.shared, pinned: saved.pinned, filters: saved.filters.map(f => f.value) }));

    // 4. A relative range: tasks overdue in the browser's own days.
    await page.goto(`http://localhost:5207/o/${orgId}/task?v=${overdue}`);
    await page.getByText('Send Chen revised quote').waitFor();
    console.log('Overdue rows in the app:', (await page.locator('tbody tr').allInnerTexts()).map(r => r.split('\t')[0]).join(' | '));
    await shot('relative-range-view.png');

    // 5. The agent's proposed view on Suggestions, then applied.
    await page.goto(`http://localhost:5207/o/${orgId}/suggestions`);
    await page.getByText('Add view Closing this week to Opportunities').waitFor();
    await page.screenshot({ path: join(here, 'suggestions-add-view.png'), fullPage: true });
    await page.getByRole('button', { name: 'Apply' }).click();
    await page.getByRole('link', { name: 'Closing this week' }).waitFor();
    console.log('after Apply, pinned links:', (await page.locator('nav a.pl-6').allInnerTexts()).join(', '));

    // 6. A retired field: the view keeps working and says what it lost.
    await owner.mutation(anyApi.fields.retire, { orgId, fieldId: o.closeDate._id });
    await page.goto(`http://localhost:5207/o/${orgId}/opportunity?v=${quotes}`);
    await page.getByText('Retired fields left this view').waitFor();
    await shot('retired-field-note.png');
    console.log('non-local requests blocked:', blocked.length ? blocked.join(' ') : 'none');
  } finally { await browser.close(); await server.close(); }
  void board;
  return {};
});
