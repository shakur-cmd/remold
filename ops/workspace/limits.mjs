// node ops/workspace/limits.mjs: whole-workspace export, import and deletion at realistic sizes on an isolated
// local Convex backend (loopback, synthetic sign-in, ops/authority/local.mjs), which enforces Convex's real
// per-function limits. Prints one JSON report and exits non-zero if any check fails.
// ONLY=roundtrip|large|parents|failure runs one scenario on its own fresh backend (each takes a few minutes).
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { withAuthority } from '../authority/local.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MB = 1024 * 1024, report = [], only = process.env.ONLY, wanted = name => !only || only.split(',').includes(name);
const timed = async (name, work) => { const start = Date.now(); try { const detail = await work(); report.push({ check: name, ok: true, seconds: (Date.now() - start) / 1000, ...detail }); } catch (error) { report.push({ check: name, ok: false, seconds: (Date.now() - start) / 1000, error: String(error?.data?.message ?? error?.message ?? error).slice(0, 300) }); } };
const shape = data => { const seen = new Map(), ids = new Set([...data.objects, ...data.fields, ...data.records, ...data.events].map(r => r.id)); data.events.forEach(e => ids.add(e.record)); const walk = x => typeof x === 'string' ? (ids.has(x) ? (seen.has(x) ? seen.get(x) : (seen.set(x, '#' + seen.size), seen.get(x))) : x) : Array.isArray(x) ? x.map(walk) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, walk(v)])) : x; return JSON.stringify(walk(data)); };

let log;
await withAuthority(async ({ client, scratch }) => {
  log = join(scratch, 'backend.log');
  const owner = client('limits-owner'), fixture = name => `workspaceLimitsFixture:${name}`, tool = client('limits-fixture');
  const run = (name, args) => (name.endsWith(':left') || name.endsWith(':orgsNamed') ? tool.query(name, args) : tool.mutation(name, args));
  await owner.mutation('users:store', {});
  const userId = (await owner.query('users:me', {}))._id;
  const workspace = async name => owner.mutation('orgs:create', { name });
  const seed = async (orgId, object, total, text = 0, link) => { const ids = []; for (let start = 0; start < total; start += 200) ids.push(...await run(fixture('seed'), { orgId, userId, object, start, count: Math.min(200, total - start), text, ...(link ? { link } : {}) })); return ids; };
  const exported = async orgId => { const result = await owner.action('workspace:exportAll', { orgId }); const text = await (await fetch(result.url)).text(); return { result, text, bytes: Buffer.byteLength(text) }; };
  const upload = async text => { const url = await owner.mutation('workspace:importUploadUrl', {}); return (await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: text })).json()).storageId; };
  const gone = async (orgId, seconds = 600) => { const deadline = Date.now() + seconds * 1000; for (;;) { const left = await run(fixture('left'), { orgId }); if (!left.length) return; if (Date.now() > deadline) throw new Error('rows left after purge: ' + left.join(', ')); await new Promise(r => setTimeout(r, 2000)); } };

  // 1. Export and import round trip at 10,000 records (100 companies, 9,900 people linked to them).
  let tenK;
  if (wanted('roundtrip') || wanted('failure')) {
  const a = await workspace('Limits 10k');
  const companies = await seed(a, 'company', 100);
  const people = Number(process.env.PEOPLE ?? 9900);
  for (let i = 0; i < people; i += 990) await seed(a, 'person', Math.min(990, people - i), 0, companies[i / 99]);
  await timed(`export ${100 + people} records`, async () => { tenK = await exported(a); const data = JSON.parse(tenK.text); assert.equal(data.records.length, 100 + people); assert.equal(data.events.length, 100 + people); return { mb: +(tenK.bytes / 1e6).toFixed(1), records: data.records.length, events: data.events.length }; });
  if (wanted('roundtrip')) await timed(`import those ${100 + people} records into a new workspace, re-export identical apart from ids`, async () => {
    const orgId = await owner.action('workspace:importAll', { storageId: await upload(tenK.text) });
    const again = await exported(orgId);
    assert.equal(shape(JSON.parse(again.text)), shape(JSON.parse(tenK.text)));
    return { records: JSON.parse(again.text).records.length };
  });
  }

  // 2. A 30 MB workspace: 3,300 companies with 4.5 KB of notes each (record plus its create event). LARGE_MB=60 for a bigger one.
  if (wanted('large')) {
  const b = await workspace('Limits 30MB');
  const largeMb = Number(process.env.LARGE_MB ?? 30);
  await seed(b, 'company', Math.ceil(3300 * largeMb / 30), 4500);
  await timed(`export a ${largeMb} MB workspace`, async () => { const { bytes, result } = await exported(b); assert.ok(bytes >= largeMb * 1e6, `${bytes} bytes`); return { mb: +(bytes / 1e6).toFixed(1), records: result.records, events: result.events }; });
  // 3. Delete it without an export: one marker write, then the bounded purge.
  if (!process.env.SKIP_DELETE) await timed(`delete the ${largeMb} MB workspace without an export`, async () => { await owner.mutation('workspace:confirmDelete', { orgId: b, confirmName: 'Limits 30MB', withoutExport: 'DELETE WITHOUT EXPORT' }); await gone(b); return {}; });
  }

  // 4. A workspace with 10,000 childless integration parents.
  if (wanted('parents')) {
  const c = await workspace('Limits parents');
  for (let i = 0; i < 10000; i += 500) await run(fixture('parents'), { orgId: c, count: 500 });
  await timed('purge 10,000 childless integration parents', async () => { await owner.mutation('workspace:confirmDelete', { orgId: c, confirmName: 'Limits parents', withoutExport: 'DELETE WITHOUT EXPORT' }); await gone(c); return { parents: 10000 }; });
  }

  // 5. An import that fails part way (a record over Convex's 1 MiB document limit) leaves no workspace behind.
  if (wanted('failure')) await timed('a failed import purges its staging workspace', async () => {
    const data = JSON.parse(tenK.text); data.workspace.name = 'Limits failing import';
    const company = data.records.find(r => r.values.name === 'company 50'); company.values.notes = 'x'.repeat(1100 * 1024);
    await assert.rejects(owner.action('workspace:importAll', { storageId: await upload(JSON.stringify(data)) }));
    const staged = await run(fixture('orgsNamed'), { name: 'Limits failing import' });
    for (const orgId of staged) await gone(orgId, 120);
    return { stagingWorkspaces: staged.length };
  });
  return {};
}, { fixtures: { workspaceLimitsFixture: join(root, 'ops/workspace/fixture.ts') } });

console.log(JSON.stringify({ level: 'SERVICE (isolated local Convex backend, loopback, synthetic data)', only: only ?? 'all', backendLog: log, checks: report }, null, 2));
if (report.some(r => !r.ok)) process.exitCode = 1;
