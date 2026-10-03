// Screenshots of agent batches on the Suggestions page, against an isolated local Convex
// backend (ops/authority/local.mjs) with synthetic data only. Sign-in normally goes through
// WorkOS; only src/lib/identity is swapped for a locally signed JWT, and the browser
// refuses every request that is not to localhost.
// PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core CHROMIUM=/usr/bin/google-chrome node evidence/2026-10-03-campaigns/H/screenshot.mjs
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
  const agent = await owner.action(anyApi.agents.create, { orgId, name: 'Research agent' });
  const objects = await owner.query(anyApi.objects.list, { orgId });
  const shape = async key => { const object = objects.find(o => o.key === key); const detail = await owner.query(anyApi.objects.get, { orgId, objectId: object._id }); return { object, f: Object.fromEntries(detail.fields.map(f => [f.key, f._id])) }; };
  const [opp, person, campaign, company] = await Promise.all(['opportunity', 'person', 'campaign', 'company'].map(shape));
  const create = async (o, values) => (await owner.mutation(anyApi.records.create, { orgId, objectId: o.object._id, values: Object.fromEntries(Object.entries(values).map(([k, v]) => [o.f[k], v])) })).recordId;
  const deals = [];
  for (const [i, name] of ['Harbor gala', 'Spring offsite', 'Riverside wedding', 'Tech meetup', 'Board dinner', 'Product launch', 'Charity run', 'Summer party', 'Team retreat', 'Book fair', 'Film night', 'Alumni brunch'].entries()) deals.push(await create(opp, { name, stage: i % 3 ? 'contacted' : 'new', amount: 4000 + i * 750 }));
  const people = [];
  for (const name of ['Ada Okafor', 'Ben Liu', 'Cy Marsh', 'Dee Patel', 'Eli Romero', 'Fay Novak', 'Gus Hale']) people.push(await create(person, { name }));
  const webinar = await create(campaign, { name: 'Spring webinar', people: [people[6]] });
  const dupes = [await create(company, { name: 'Acme Events (old)' }), await create(company, { name: 'Acme Events (copy)' })];
  await create(person, { name: 'Hal Acme', company: dupes[0] });
  const post = async body => { const response = await fetch(site + '/api/v1/batches', { method: 'POST', headers: { authorization: `Bearer ${agent.key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }); const json = await response.json(); if (response.status !== 201) throw new Error(JSON.stringify(json)); return json.batch; };
  const stages = await post({ reason: 'All twelve replied to the venue questionnaire this week, so they are qualified.', changes: deals.map(record => ({ action: 'update', record, values: { stage: 'Qualified' } })) });
  await post({ reason: 'These six signed up on the webinar form.', changes: [{ action: 'update', record: webinar, links: { people: { add: people.slice(0, 6) } } }] });
  await post({ reason: 'Duplicates of Acme Events from the old import.', changes: dupes.map(record => ({ action: 'delete', record })) });
  // A person moves one deal on before the batch is applied, so the batch skips it.
  await owner.mutation(anyApi.records.update, { orgId, recordId: deals[4], values: { [opp.f.stage]: 'proposal' } });

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
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/google-chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const blocked = [];
    await page.route('**/*', route => { const host = new URL(route.request().url()).hostname; if (host === 'localhost' || host === '127.0.0.1') return route.continue(); blocked.push(route.request().url()); return route.abort(); });
    await page.addInitScript(t => { window.__REMOLD_TOKEN = t; }, token('shot-owner', { name: 'Sam Rivera' }));
    page.on('console', m => { if (m.type() === 'error') console.log('page error:', m.text().slice(0, 300)); });
    await page.goto(`http://localhost:5198/o/${orgId}/suggestions`);
    const card = page.getByText(stages.summary).locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]');
    await card.waitFor({ timeout: 60000 }).catch(async error => { await page.screenshot({ path: join(scratch, 'debug.png') }); console.log('debug screenshot', join(scratch, 'debug.png')); throw error; });
    await page.getByText('Add 6 People to Spring webinar').waitFor();
    await page.getByText('Harbor gala').waitFor();
    await page.screenshot({ path: join(here, 'batch-cards.png'), fullPage: true });
    await card.getByRole('button', { name: 'Next' }).click();
    await card.getByText('Alumni brunch').waitFor();
    await card.screenshot({ path: join(here, 'batch-card-page-2.png') });
    await card.getByRole('button', { name: 'Previous' }).click();
    await card.getByRole('button', { name: 'Apply all 12' }).click();
    const finished = page.getByText('Finished batches');
    await finished.waitFor({ timeout: 60000 });
    const done = page.getByText(stages.summary).locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]');
    await done.getByText('Applied 11 of 12, skipped 1 changed since review').waitFor();
    await done.getByRole('button', { name: 'Skipped 1' }).click();
    await done.getByText('Changed since review, so it was skipped').waitFor();
    await done.screenshot({ path: join(here, 'batch-card-finished.png') });
    const rows = await owner.query(anyApi.records.list, { orgId, objectId: opp.object._id, paginationOpts: { cursor: null, numItems: 50 } });
    console.log('stages after Apply all:', JSON.stringify(Object.fromEntries(rows.page.map(r => [r.title, r.values[opp.f.stage]]))));
    console.log('non-local requests blocked:', blocked.length ? blocked.join(' ') : 'none');
  } finally { await browser.close(); await server.close(); }
  return {};
});
