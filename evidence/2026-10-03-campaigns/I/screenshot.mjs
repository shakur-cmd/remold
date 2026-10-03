// Screenshot of an automation's record page, against an isolated local Convex backend
// (ops/authority/local.mjs) with synthetic data only. An agent drafts the automation over
// REST, a person turns it on, a deal is won, and the real runner (scheduler) runs it.
// Sign-in normally goes through WorkOS; here only src/lib/identity is swapped for a
// locally signed JWT, and the browser refuses every request that is not to localhost.
// PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core node evidence/2026-10-03-campaigns/I/screenshot.mjs
import { execFileSync } from 'node:child_process';
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
const sleep = ms => new Promise(r => setTimeout(r, ms));

await withAuthority(async ({ scratch, client, token, url, site }) => {
  execFileSync(process.execPath, [join(root, 'node_modules/convex/bin/main.js'), 'env', 'set', 'REMOLD_AUTOMATION_DAILY_CAP', '50'], { cwd: scratch, env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CONVEX_AGENT_MODE: 'anonymous', CI: '1', CONVEX_DISABLE_METRICS: '1' }, stdio: 'ignore', timeout: 60000 });
  const owner = client('shot-owner', { name: 'Sam Rivera' });
  await owner.mutation(anyApi.users.store, {});
  const orgId = await owner.mutation(anyApi.orgs.create, { name: 'Northwind Events' });
  const agent = await owner.action(anyApi.agents.create, { orgId, name: 'Ops agent', grants: ['create', 'update'].map(action => ({ action, objectKey: 'automation' })) });
  const api = async (method, path, body) => { const response = await fetch(site + '/api/v1' + path, { method, headers: { authorization: `Bearer ${agent.key}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const json = await response.json(); if (!response.ok) throw new Error(JSON.stringify(json)); return json; };
  const actions = [
    { type: 'createRecord', object: 'project', values: { name: 'Delivery: {{record.name}}', company: '{{record.company}}', status: 'active' } },
    { type: 'createTask', title: 'Kickoff call with {{record.name}}', dueInDays: 1, about: 'trigger', values: { project: '{{created.project}}' } },
    { type: 'createTask', title: 'Send the welcome pack', dueInDays: 2, values: { project: '{{created.project}}' } },
    { type: 'createTask', title: 'First check-in', dueInDays: 7, values: { project: '{{created.project}}' } },
  ];
  const drafted = await api('POST', '/changes', { action: 'create', object: 'automation', values: { name: 'Won deal to delivery', when: 'fieldChanged', object: 'opportunity', field: 'stage', equals: 'won', actions: JSON.stringify(actions) }, reason: 'Every won deal needs a delivery project and its first tasks' });
  const automationId = drafted.record.id;
  console.log('agent drafted:', drafted.record.values.status);
  const refused = await fetch(site + '/api/v1/changes', { method: 'POST', headers: { authorization: `Bearer ${agent.key}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'update', record: automationId, values: { status: 'on' }, reason: 'switch on' }) });
  console.log('agent tried to turn it on:', refused.status, (await refused.json()).error.message);
  const objects = await owner.query(anyApi.objects.list, { orgId }), byKey = async key => { const o = objects.find(x => x.key === key); return { o, f: Object.fromEntries((await owner.query(anyApi.objects.get, { orgId, objectId: o._id })).fields.map(f => [f.key, f._id])) }; };
  const company = await byKey('company'), opp = await byKey('opportunity');
  const acme = (await owner.mutation(anyApi.records.create, { orgId, objectId: company.o._id, values: { [company.f.name]: 'Acme Plumbing' } })).recordId;
  const deal = (await owner.mutation(anyApi.records.create, { orgId, objectId: opp.o._id, values: { [opp.f.name]: 'Acme website', [opp.f.stage]: 'proposal', [opp.f.company]: acme, [opp.f.amount]: 4800 } })).recordId;
  const ref = (await owner.query(anyApi.records.get, { orgId, recordId: deal })).record.ref;
  const test = await api('POST', `/automations/${automationId}/test`, { record: ref });
  console.log('dry run:', test.sentence, '|', test.steps.length, 'steps |', test.problems.length, 'problems');
  await owner.mutation(anyApi.automations.setOn, { orgId, recordId: automationId, on: true });
  await owner.mutation(anyApi.records.update, { orgId, recordId: deal, values: { [opp.f.stage]: 'won' } });
  let view;
  for (let i = 0; i < 60; i++) { view = await owner.query(anyApi.automations.view, { orgId, recordId: automationId }); if (view.runs[0]?.status && view.runs[0].status !== 'queued') break; await sleep(500); }
  console.log('run:', view.runs[0].status, '| created', view.runs[0].created.map(c => c.title).join(', '));
  const runs = await api('GET', `/automations/${automationId}/runs`);
  console.log('agent reads runs:', runs.runs.length, runs.runs[0].status, 'as', runs.runs[0].enabledBy);

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
  const browser = await chromium.launch({ executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
    const blocked = [];
    await page.route('**/*', route => { const host = new URL(route.request().url()).hostname; if (host === 'localhost' || host === '127.0.0.1') return route.continue(); blocked.push(route.request().url()); return route.abort(); });
    await page.addInitScript(t => { window.__REMOLD_TOKEN = t; }, token('shot-owner', { name: 'Sam Rivera' }));
    page.on('console', m => { if (m.type() === 'error') console.log('page error:', m.text().slice(0, 300)); });
    await page.goto(`http://localhost:5199/o/${orgId}/automation/${automationId}`);
    await page.getByText('Run history').waitFor({ timeout: 60000 }).catch(async error => { await page.screenshot({ path: join(scratch, 'debug.png') }); console.log('debug screenshot', join(scratch, 'debug.png')); throw error; });
    await page.getByText('Delivery: Acme website').first().waitFor();
    await page.screenshot({ path: join(here, 'automation-record-page.png'), fullPage: true });
    // Pausing from the page, then the draft-style view with the Turn on button.
    await page.getByRole('button', { name: 'Pause' }).click();
    await page.getByRole('button', { name: 'Turn on' }).waitFor();
    console.log('after clicking Pause, status:', (await owner.query(anyApi.automations.view, { orgId, recordId: automationId })).status);
    await page.screenshot({ path: join(here, 'automation-paused.png'), fullPage: true });
    console.log('non-local requests blocked:', blocked.length ? blocked.join(' ') : 'none');
  } finally { await browser.close(); await server.close(); }
  return {};
});
