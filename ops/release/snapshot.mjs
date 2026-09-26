import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sha = value => createHash('sha256').update(value).digest('hex');
const clean = value => Array.isArray(value) ? value.map(clean) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, clean(value[key])])) : value;
export function canonical(zipPath) {
  const tables = {}, skipped = [];
  for (const file of execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)) {
    const match = /^([^/]+)\/documents\.jsonl$/.exec(file);
    if (!match || match[1] === '_storage' || file.includes('_components/')) { skipped.push(file); continue; }
    const docs = execFileSync('unzip', ['-p', zipPath, file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean).map(JSON.parse).sort((a, b) => String(a._id).localeCompare(String(b._id)));
    tables[match[1]] = { count: docs.length, sha256: sha(JSON.stringify(clean(docs))) };
  }
  const sorted = Object.fromEntries(Object.keys(tables).sort().map(key => [key, tables[key]]));
  return { tables: sorted, sha256: sha(JSON.stringify(sorted)), skipped: skipped.sort() };
}
const fixture = `import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { seedStandard } from "./lib/standard";
export const seed = internalMutation({args:{},handler:async ctx=>{const userId=await ctx.db.insert("users",{tokenIdentifier:"snapshot-fixture",name:"Snapshot fixture user"});const orgId=await ctx.db.insert("orgs",{name:"Snapshot fixture org",createdBy:userId});await ctx.db.insert("members",{orgId,userId,role:"owner"});await seedStandard(ctx,orgId);const object=await ctx.db.query("objects").withIndex("by_org_key",q=>q.eq("orgId",orgId).eq("key","company")).unique();if(!object?.titleFieldId)throw new Error("Company fixture missing");await ctx.db.insert("agents",{orgId,name:"Snapshot fixture key",role:"member",createdBy:userId,keyHash:"snapshot-fixture-hash",keyPrefix:"fixture",grants:[]});return {orgId,userId,objectId:object._id,titleFieldId:object.titleFieldId}}});
export const seedBatch=internalMutation({args:{orgId:v.id("orgs"),userId:v.id("users"),objectId:v.id("objects"),titleFieldId:v.id("fields"),start:v.number(),count:v.number()},handler:async(ctx,args)=>{for(let i=args.start;i<args.start+args.count;i++){const title=\`Snapshot fixture \${String(i).padStart(4,"0")}\`;await ctx.db.insert("records",{orgId:args.orgId,objectId:args.objectId,values:{[args.titleFieldId]:title},title,createdBy:args.userId,updatedAt:0})}}});
`;
function setup(source, prefix, permissive = false) {
  const scratch = mkdtempSync(join(tmpdir(), prefix));
  cpSync(join(source, 'convex'), join(scratch, 'convex'), { recursive: true, filter: path => !path.endsWith('.test.ts') && !path.endsWith('test.helpers.ts') && !path.endsWith('test.setup.ts') });
  // Since I1 the schema imports shared validators from packages/contracts.
  cpSync(join(source, 'packages/contracts'), join(scratch, 'packages/contracts'), { recursive: true });
  writeFileSync(join(scratch, 'convex/auth.config.ts'), 'export default { providers: [] };\n');
  if (permissive) writeFileSync(join(scratch, 'convex/schema.ts'), 'import { defineSchema } from "convex/server"; export default defineSchema({}, { schemaValidation: false });\n');
  writeFileSync(join(scratch, 'package.json'), JSON.stringify({ name: 'remold-snapshot-local', private: true, type: 'module', dependencies: { convex: '1.46.0', '@convex-dev/rate-limiter': '0.4.0' } }));
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir'); return scratch;
}
async function local(source, prefix, ports, permissive, work) {
  const scratch = setup(source, prefix, permissive), [cloud = 3460, site = 3461] = ports ?? [];
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CONVEX_AGENT_MODE: 'anonymous', CI: '1', CONVEX_DISABLE_METRICS: '1' };
  const cli = join(root, 'node_modules/convex/bin/main.js'), config = () => existsSync(join(root, '.env.local')) ? sha(readFileSync(join(root, '.env.local'))) : null, before = config(); let logs = '';
  const backend = spawn(process.execPath, [cli, 'dev', '--typecheck', 'disable', '--tail-logs', 'disable', '--local-cloud-port', String(cloud), '--local-site-port', String(site)], { cwd: scratch, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  backend.stdout.on('data', data => { logs += data; }); backend.stderr.on('data', data => { logs += data; });
  const wait = async (offset = 0, validation = false) => { const end = Date.now() + 180_000; for (;;) { const recent = logs.slice(offset); if (validation && /Schema validation failed|Failed to|Document with ID .* does not match the schema/i.test(recent)) throw new Error(recent.match(/.*(?:Schema validation failed|Failed to|Document with ID .* does not match the schema).*$/im)?.[0]?.slice(0, 500) ?? recent.slice(0, 500)); if (/Convex functions ready/.test(recent)) return; if (backend.exitCode !== null || Date.now() > end) throw new Error(`Local backend failed to become ready: ${recent.slice(-500)}`); await new Promise(done => setTimeout(done, 200)); } };
  const run = (...args) => execFileSync(process.execPath, [cli, ...args], { cwd: scratch, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 64 * 1024 * 1024 });
  try { await wait(); const url = /^(?:VITE_)?CONVEX_URL=(.+)$/m.exec(readFileSync(join(scratch, '.env.local'), 'utf8'))?.[1]; assert.ok(url && new URL(url).hostname === '127.0.0.1', 'Refusing non-loopback backend'); return await work({ scratch, logs: () => logs, run, wait }); }
  finally { writeFileSync(join(scratch, 'backend.log'), logs); assert.equal(config(), before, 'Root deployment config changed'); try { process.kill(-backend.pid, 'SIGTERM'); } catch {} }
}
export async function restoreDrill({ source, snapshot, ports = [3460, 3461] }) {
  const candidateSchemaSha256 = sha(readFileSync(join(source, 'convex/schema.ts'))), snapshotSha256 = sha(readFileSync(snapshot)), original = canonical(snapshot); let scratch;
  try { const result = await local(source, 'remold-snapshot-restore-', ports, true, async local => { scratch = local.scratch; local.run('import', '--replace-all', '-y', snapshot); const restored = join(local.scratch, 'restored.zip'); local.run('export', '--path', restored); assert.deepEqual(canonical(restored), original, 'restore faithful'); const offset = local.logs().length; cpSync(join(source, 'convex/schema.ts'), join(local.scratch, 'convex/schema.ts')); await local.wait(offset, true); const candidate = join(local.scratch, 'candidate.zip'); local.run('export', '--path', candidate); assert.deepEqual(canonical(candidate), original, 'candidate push preserved data'); return { result: 'PASS', canonical: original }; }); return { ...result, snapshotSha256, candidateSchemaSha256, scratch }; }
  catch (error) { return { result: 'FAIL', reason: String(error.message).slice(0, 500), snapshotSha256, candidateSchemaSha256, canonical: original, scratch }; }
}
export async function seedSnapshot({ source, out, ports = [3462, 3463] }) {
  return local(source, 'remold-snapshot-seed-', ports, false, async local => { writeFileSync(join(local.scratch, 'convex/snapshotFixture.ts'), fixture); await local.wait(local.logs().length); const data = JSON.parse(local.run('run', 'snapshotFixture:seed', '{}').trim()); for (let start = 0; start < 250; start += 50) local.run('run', 'snapshotFixture:seedBatch', JSON.stringify({ ...data, start, count: 50 })); local.run('export', '--path', out); return { out, sha256: sha(readFileSync(out)), canonical: canonical(out) }; });
}
