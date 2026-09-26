// Independent I1 migration attack. Starts the pre-I1 backend (3339517), drives it with an
// MCP client built separately from 3339517 with its own lockfile (IV_OLD_MCP), then walks
// freeze -> enforcing code before backfill -> migrated -> real pre-I1 code rollback -> roll forward.
// The comparison is an ability matrix (status per agent x object x operation), not a transcript.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { anyApi } from 'convex/server';
import { withAuthority, evidencePath } from '../../../ops/authority/local.mjs';

const OLD = process.env.IV_OLD_MCP ?? '/tmp/i1iv/old-3339517/packages/mcp';
const { Client } = await import(join(OLD, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'));
const { StdioClientTransport } = await import(join(OLD, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'));
const REQUIRED = { company: 'name', person: 'name', opportunity: 'name', project: 'name', task: 'title', note: 'body', campaign: 'name' };

const report = await withAuthority(async f => {
  const log = [], findings = [];
  const note = (phase, what, value) => { log.push({ phase, what, value }); console.log(phase.padEnd(22), what, JSON.stringify(value).slice(0, 300)); };
  const owner = f.client('iv-mig-owner'); await owner.mutation(anyApi.users.store, {});
  const org = await owner.mutation(anyApi.orgs.create, { name: 'IV migration org' }), org2 = await owner.mutation(anyApi.orgs.create, { name: 'IV rename org' });
  const mk = (orgId, name, role, grants) => owner.action(anyApi.agents.create, { orgId, name, role, grants });
  const W = await mk(org, 'wildcard', 'admin', ['create', 'update', 'delete'].map(action => ({ action, objectKey: '*' })));
  const K = await mk(org, 'explicit', 'member', [{ action: 'update', objectKey: 'vendor' }, { action: 'create', objectKey: 'company' }]);
  const R = await mk(org, 'readonly-legacy', 'member', []);
  const W2 = await mk(org2, 'wildcard2', 'admin', ['create', 'update', 'delete'].map(action => ({ action, objectKey: '*' })));
  const K2 = await mk(org2, 'explicit2', 'member', [{ action: 'update', objectKey: 'vendor' }]);
  const agents = { W, K, R };
  const rest = key => async (method, path, body) => { const r = await fetch(f.site + '/api/v1/' + path, { method, headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {} return { status: r.status, text, json }; };
  const seedRecord = async (orgId, key) => { const objects = await owner.query(anyApi.objects.list, { orgId }), o = objects.find(x => x.key === key), d = await owner.query(anyApi.objects.get, { orgId, objectId: o._id }); const fid = d.fields.find(x => x.key === (REQUIRED[key] ?? 'name'))._id; return (await owner.mutation(anyApi.records.create, { orgId, objectId: o._id, values: { [fid]: 'Seed ' + key + ' ' + Date.now() } })).recordId; };
  const matrix = async (keys, phase) => {
    const out = {};
    for (const [name, a] of Object.entries(agents)) for (const key of keys) {
      const call = rest(a.key), field = REQUIRED[key] ?? 'name', target = await seedRecord(org, key);
      const create = await call('POST', 'changes', { action: 'create', object: key, values: { [field]: 'IV ' + phase }, reason: 'iv' });
      const update = await call('POST', 'changes', { action: 'update', record: target, values: { [field]: 'IV upd ' + phase }, reason: 'iv' });
      const del = await call('POST', 'changes', { action: 'delete', record: target, reason: 'iv' });
      const list = await call('GET', 'records?object=' + key), propose = await call('POST', 'suggestions', { action: 'create', object: key, values: { [field]: 'IV prop' }, reason: 'iv' });
      out[`${name}:${key}`] = [create.status, update.status, del.status, list.status, propose.status].join(' ');
      if (create.status === 200) await call('POST', 'changes', { action: 'delete', record: create.json.record.id, reason: 'iv cleanup' });
    }
    return out;
  };
  const baseKeys = Object.keys(REQUIRED);
  const mcpFor = async key => { const c = new Client({ name: 'iv-old-mcp', version: '1' }); await c.connect(new StdioClientTransport({ command: process.execPath, args: [join(OLD, 'dist/index.js')], env: { PATH: process.env.PATH, REMOLD_URL: f.site, REMOLD_KEY: key }, stderr: 'pipe' })); return c; };
  const mcpW = await mcpFor(W.key), mcpR = await mcpFor(R.key);
  const mcp = async (c, name, args) => { const r = await c.callTool({ name, arguments: args }); return { isError: !!r.isError, text: r.content?.[0]?.text?.slice(0, 200) }; };
  const mcpAbilities = async () => ({
    W_me: (await mcp(mcpW, 'remold_me', {})).isError, W_objects: JSON.parse((await mcpW.callTool({ name: 'remold_objects', arguments: {} })).content[0].text).map(o => o.key).sort().join(','),
    W_apply: (await mcp(mcpW, 'remold_apply_change', { action: 'create', object: 'company', values: { name: 'MCP co' }, reason: 'iv' })).isError,
    R_apply: (await mcp(mcpR, 'remold_apply_change', { action: 'create', object: 'company', values: { name: 'MCP co' }, reason: 'iv' })).isError,
    R_propose: (await mcp(mcpR, 'remold_propose_change', { action: 'create', object: 'company', values: { name: 'MCP prop' }, reason: 'iv' })).isError,
  });
  try {
    // ---- baseline: pre-I1 code ----
    const baseline = await matrix(baseKeys, 'baseline'), baseMcp = await mcpAbilities(); note('baseline', 'matrix', baseline); note('baseline', 'oldMcp', baseMcp);
    const baselineSchema = readFileSync(join(f.scratch, 'convex/schema.ts'), 'utf8'), authConfig = readFileSync(join(f.scratch, 'convex/auth.config.ts'), 'utf8');
    const r0Files = ['convex/schema.ts', 'convex/errors.ts', 'convex/integrations/tables.ts', 'convex/authority/migration.ts'];
    // ---- R0: expanded schema + freeze entrypoint on old code ----
    await f.reload(() => { for (const p of r0Files) { mkdirSync(join(f.scratch, p, '..'), { recursive: true }); cpSync(join(f.root, p), join(f.scratch, p)); } });
    for (const o of [org, org2]) f.run('authority/migration:freeze', { orgId: o });
    // ---- enforcing I1 code, before backfill ----
    const enforce = () => f.reload(() => { cpSync(join(f.root, 'convex'), join(f.scratch, 'convex'), { recursive: true, filter: p => !/\.test\.ts$|test\.helpers\.ts$|test\.setup\.ts$|auth\.config\.ts$/.test(p) }); writeFileSync(join(f.scratch, 'convex/auth.config.ts'), authConfig); });
    await enforce();
    const pre = await matrix(baseKeys, 'pre-backfill'), preMcp = await mcpAbilities(); note('pre-backfill', 'matrix', pre); note('pre-backfill', 'oldMcp', preMcp);
    if (JSON.stringify(pre) !== JSON.stringify(baseline)) findings.push({ phase: 'pre-backfill', issue: 'ability matrix differs from baseline', diff: Object.keys(baseline).filter(k => baseline[k] !== pre[k]).map(k => [k, baseline[k], pre[k]]) });
    if (JSON.stringify(preMcp) !== JSON.stringify(baseMcp)) findings.push({ phase: 'pre-backfill', issue: 'old MCP abilities differ', baseMcp, preMcp });
    // Future object and a record in it, created after the freeze.
    const vendor = await owner.mutation(anyApi.objects.create, { orgId: org, key: 'vendor', label: 'Vendor', labelPlural: 'Vendors' }), vendorRecord = await seedRecord(org, 'vendor');
    const futureProbe = async phase => {
      const res = {};
      for (const [name, a] of Object.entries(agents)) {
        const call = rest(a.key);
        res[name] = {
          create: (await call('POST', 'changes', { action: 'create', object: 'vendor', values: { name: 'x' }, reason: 'iv' })).status,
          update: (await call('POST', 'changes', { action: 'update', record: vendorRecord, values: { name: 'x' }, reason: 'iv' })).status,
          get: (await call('GET', 'records/' + vendorRecord)).status, list: (await call('GET', 'records?object=vendor')).status,
          propose: (await call('POST', 'suggestions', { action: 'update', record: vendorRecord, values: { name: 'y' }, reason: 'iv' })).status,
          noteAbout: (await call('POST', 'changes', { action: 'create', object: 'note', values: { body: 'link', about: vendorRecord }, reason: 'iv' })).status,
          searchLeak: (await call('GET', 'search?q=Seed%20vendor')).text.includes(vendorRecord),
          related: (await call('GET', 'records/' + vendorRecord + '/related?field=note.about')).status,
        };
      }
      res.mcpApply = (await mcp(mcpW, 'remold_apply_change', { action: 'create', object: 'vendor', values: { name: 'x' }, reason: 'iv' })).isError;
      note(phase, 'future-object probe', res);
      for (const [name, r] of Object.entries(res)) if (typeof r === 'object') { for (const [op, s] of Object.entries(r)) if (s === 200 || s === 201 || s === true) findings.push({ phase, issue: `${name} ${op} on post-freeze object allowed/leaked`, status: s }); }
      if (res.mcpApply === false) findings.push({ phase, issue: 'old MCP apply on post-freeze object allowed' });
      return res;
    };
    const preFuture = await futureProbe('pre-backfill');
    // Rename attacks in org2 (operator-only path; there is no public object rename).
    const objs2 = await owner.query(anyApi.objects.list, { orgId: org2 }), project2 = objs2.find(o => o.key === 'project'), campaign2 = objs2.find(o => o.key === 'campaign');
    const later2 = await owner.mutation(anyApi.objects.create, { orgId: org2, key: 'later', label: 'Later', labelPlural: 'Later' });
    f.run('authorityFixture:keyReuse', { objectId: project2._id, key: 'oldProject' }); f.run('authorityFixture:keyReuse', { objectId: later2, key: 'project' });
    f.run('authorityFixture:keyReuse', { objectId: campaign2._id, key: 'vendor' });
    const campaignRec = await seedRecord(org2, 'vendor');
    const renameProbe = async phase => {
      const res = {
        W2_createOnRenamedPostFreeze: (await rest(W2.key)('POST', 'changes', { action: 'create', object: 'project', values: { name: 'x' }, reason: 'iv' })).status,
        K2_updatePreFreezeRenamedIntoItsKey: (await rest(K2.key)('POST', 'changes', { action: 'update', record: campaignRec, values: { name: 'renamed-into-grant' }, reason: 'iv' })).status,
      };
      note(phase, 'rename probe (org2)', res);
      if (res.W2_createOnRenamedPostFreeze === 200) findings.push({ phase, issue: 'wildcard agent wrote a post-freeze object renamed to a pre-freeze key' });
      if (res.K2_updatePreFreezeRenamedIntoItsKey === 200) findings.push({ phase, severity: 'low/operator-only', issue: 'explicit legacy grant for a key that matched nothing at freeze follows an operator rename onto a pre-freeze object' });
      return res;
    };
    const preRename = await renameProbe('pre-backfill');
    // ---- backfill ----
    for (const a of [W, K, R]) f.run('authority/migration:migrateAgent', { agentId: a.agentId });
    const migratedResults = {};
    for (const a of [W2, K2]) migratedResults[a.agentId] = f.run('authority/migration:migrateAgent', { agentId: a.agentId });
    note('migrated', 'org2 migrate results', migratedResults);
    const mig = await matrix(baseKeys, 'migrated'), migMcp = await mcpAbilities(); note('migrated', 'matrix', mig);
    if (JSON.stringify(mig) !== JSON.stringify(baseline)) findings.push({ phase: 'migrated', issue: 'ability matrix differs from baseline', diff: Object.keys(baseline).filter(k => baseline[k] !== mig[k]).map(k => [k, baseline[k], mig[k]]) });
    if (JSON.stringify(migMcp) !== JSON.stringify(baseMcp)) findings.push({ phase: 'migrated', issue: 'old MCP abilities differ', baseMcp, migMcp });
    const migFuture = await futureProbe('migrated'), migRename = await renameProbe('migrated');
    // A post-I1 scoped agent with a narrow read grant, and a mask on W, to observe what a real rollback does.
    const objs = await owner.query(anyApi.objects.list, { orgId: org }), comp = objs.find(o => o.key === 'company'), cd = await owner.query(anyApi.objects.get, { orgId: org, objectId: comp._id });
    const city = cd.fields.find(x => x.key === 'city'), name = cd.fields.find(x => x.key === 'name');
    await owner.mutation(anyApi.records.create, { orgId: org, objectId: comp._id, values: { [name._id]: 'Masked Co', [city._id]: 'HIDDENCITY' } });
    const S = await owner.action(anyApi.agents.createScoped, { orgId: org, name: 'scoped', origin: 'external' });
    await owner.mutation(anyApi['authority/policies'].setAgentMasks, { orgId: org, agentId: W.agentId, hiddenFieldIds: [city._id] });
    const exposure = async phase => {
      const wList = await rest(W.key)('GET', 'records?object=company'), sList = await rest(S.key)('GET', 'records?object=company'), sVendor = await rest(S.key)('GET', 'records?object=vendor');
      const res = { W_seesHiddenCity: wList.text.includes('HIDDENCITY'), S_companyList: sList.status, S_vendorList: sVendor.status, W_vendorCreate: (await rest(W.key)('POST', 'changes', { action: 'create', object: 'vendor', values: { name: 'rb' }, reason: 'iv' })).status };
      note(phase, 'exposure', res); return res;
    };
    const enforcingExposure = await exposure('migrated');
    // ---- real rollback to pre-I1 code (3339517) with the expanded schema kept (the only schema that still validates) ----
    const old = mkdtempSync(join(tmpdir(), 'iv-3339517-')); execFileSync('tar', ['-x', '-C', old], { input: execFileSync('git', ['archive', '3339517', 'convex'], { cwd: f.root }) });
    const rollback = await attempt(() => f.reload(() => {
      cpSync(join(old, 'convex'), join(f.scratch, 'convex'), { recursive: true, filter: p => !/\.test\.ts$|test\.helpers\.ts$|test\.setup\.ts$|auth\.config\.ts$/.test(p) });
      for (const p of r0Files) cpSync(join(f.root, p), join(f.scratch, p));
      writeFileSync(join(f.scratch, 'convex/auth.config.ts'), authConfig);
    }));
    note('pre-I1-rollback', 'deploy', rollback.ok ? 'deployed' : rollback.error);
    let rolledExposure = null, rolledMatrix = null;
    if (rollback.ok) {
      rolledExposure = await exposure('pre-I1-rollback'); rolledMatrix = await matrix(baseKeys, 'pre-I1-rollback');
      if (rolledExposure.W_seesHiddenCity || rolledExposure.S_companyList === 200 || rolledExposure.S_vendorList === 200) findings.push({ phase: 'pre-I1-rollback', issue: 'rolling code back to pre-I1 after migration drops masks and scoped-agent read limits', rolledExposure });
      await futureProbe('pre-I1-rollback'); await renameProbe('pre-I1-rollback');
    }
    // ---- roll forward to enforcing code ----
    await enforce(); const forward = await exposure('roll-forward'), fwdFuture = await futureProbe('roll-forward');
    const schemaRollback = await attempt(() => f.reload(() => writeFileSync(join(f.scratch, 'convex/schema.ts'), baselineSchema), true));
    note('schema-rollback', 'baseline schema deploy', schemaRollback.ok ? 'refused by schema validation (as expected)' : schemaRollback.error);
    return { log, findings, baseline, baseMcp, pre, preMcp, mig, migMcp, rolledMatrix, preFuture, migFuture, preRename, migRename, enforcingExposure, rolledExposure, forward, fwdFuture, oldMcpSha: f.sha(readFileSync(join(OLD, 'dist/index.js'))) };
  } finally { await mcpW.close(); await mcpR.close(); }
}, { sourceRevision: '3339517' });
async function attempt(fn) { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: String(e?.message ?? e).slice(0, 300) }; } }
writeFileSync(evidencePath('iv-migration.json'), JSON.stringify(report, null, 2) + '\n');
console.log('\nFINDINGS', JSON.stringify(report.findings, null, 1));
