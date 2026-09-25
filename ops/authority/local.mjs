import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, symlinkSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import assert from 'node:assert/strict';
import { ConvexHttpClient } from 'convex/browser';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export async function withAuthority(check, { safetySim = false, safetyHang = false, sourceRevision } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'remold-authority-')), cli = join(root, 'node_modules/convex/bin/main.js');
  const sha = x => createHash('sha256').update(x).digest('hex');
  const envHash = () => existsSync(join(root, '.env.local')) ? sha(readFileSync(join(root, '.env.local'))) : null, before = envHash();
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CONVEX_AGENT_MODE: 'anonymous', CI: '1', CONVEX_DISABLE_METRICS: '1' };
  if (sourceRevision) {
    assert.match(sourceRevision, /^[a-f0-9]{7,40}$/);
    const archive = execFileSync('git', ['archive', sourceRevision, 'convex'], { cwd: root });
    execFileSync('tar', ['-x', '-C', scratch], { input: archive });
  } else {
  cpSync(join(root, 'convex'), join(scratch, 'convex'), { recursive: true, filter: p => !p.endsWith('.test.ts') && !p.endsWith('test.helpers.ts') && !p.endsWith('test.setup.ts') });
  }
  cpSync(join(root, 'packages/contracts'), join(scratch, 'packages/contracts'), { recursive: true });
  cpSync(join(root, sourceRevision ? 'ops/authority/migration-fixture.ts' : 'ops/authority/fixture.ts'), join(scratch, 'convex/authorityFixture.ts'));
  const safetyRegistry = join(scratch, 'convex/integrations/safetyAdapters.ts');
  const productionSafetyHash = existsSync(safetyRegistry) ? sha(readFileSync(safetyRegistry)) : null;
  if (safetySim) {
    const source = readFileSync(safetyRegistry, 'utf8');
    writeFileSync(safetyRegistry, source.replace('= {};', '= { fake: { \"billing.refund\": { proofRef: \"SIM: isolated unknown-outcome adapter\", finality: { proofRef: \"SIM: deterministic no-provider absence\", verifyAbsent: async () => true }, dispatch: async () => { throw new Error(\"SIM unknown\"); } }, \"billing.cancelRecurring\": { proofRef: \"SIM: isolated unknown-outcome adapter\", finality: { proofRef: \"SIM: deterministic no-provider absence\", verifyAbsent: async () => true }, dispatch: async () => { throw new Error(\"SIM unknown\"); } } } };'));
  }
  if (safetySim && safetyHang) writeFileSync(safetyRegistry, readFileSync(safetyRegistry, 'utf8').replaceAll('throw new Error("SIM unknown");', 'return await new Promise(() => {});'));
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'isolated-proof', alg: 'RS256', use: 'sig' }] };
  const issuer = 'https://isolated-authority.invalid', audience = 'isolated-remold';
  writeFileSync(join(scratch, 'convex/auth.config.ts'), 'export default ' + JSON.stringify({ providers: [{ type: 'customJwt', issuer, applicationID: audience, algorithm: 'RS256', jwks: 'data:text/plain;charset=utf-8;base64,' + Buffer.from(JSON.stringify(jwks)).toString('base64') }] }) + ';\n');
  writeFileSync(join(scratch, 'package.json'), JSON.stringify({ name: 'remold-authority-proof', private: true, type: 'module', dependencies: { convex: '1.46.0', '@convex-dev/rate-limiter': '0.4.0' } }));
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir');
  let logs = '';
  const backend = spawn(process.execPath, [cli, 'dev', '--typecheck', 'disable', '--tail-logs', 'disable', '--local-cloud-port', '3480', '--local-site-port', '3481'], { cwd: scratch, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  backend.stdout.on('data', b => { logs += b; }); backend.stderr.on('data', b => { logs += b; });
  const run = (fn, args = {}) => {
    const output = execFileSync(process.execPath, [cli, 'run', fn, JSON.stringify(args)], { cwd: scratch, env, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }); return output.trim() ? JSON.parse(output) : null;
  };
  const token = (subject, extra = {}) => {
    const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'RS256', kid: 'isolated-proof' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ iss: issuer, aud: audience, sub: subject, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, name: 'Synthetic ' + subject, sid: 'synthetic-' + subject, ...extra })).toString('base64url');
    const unsigned = header + '.' + claims; return unsigned + '.' + sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url');
  };
  try {
    const deadline = Date.now() + 180000;
    while (!/Convex functions ready/.test(logs)) {
      if (backend.exitCode !== null || Date.now() > deadline) throw new Error('Isolated backend failed; logs in ' + scratch);
      await new Promise(r => setTimeout(r, 200));
    }
    const config = readFileSync(join(scratch, '.env.local'), 'utf8'), url = /^(?:VITE_)?CONVEX_URL=(.+)$/m.exec(config)?.[1];
    assert.equal(url, 'http://127.0.0.1:3480');
    const client = (subject, extra) => { const c = new ConvexHttpClient(url, { logger: false }); c.setAuth(token(subject, extra)); return c; };
    const sourceManifest = () => { const manifest = {}; for (const dir of ['convex', 'packages/contracts']) for (const file of readdirSync(join(scratch, dir), { recursive: true }).filter(p => p.endsWith('.ts') || p.endsWith('.json'))) manifest[dir + '/' + file] = sha(readFileSync(join(scratch, dir, file))); return manifest; };
    const manifest = sourceManifest();
    const exportFixture = () => { const path = join(scratch, 'fixture.zip'); execFileSync(process.execPath, [cli, 'export', '--path', path], { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }); const retained = join(root, 'ops/authority/evidence/fixture-' + basename(scratch) + '.zip'); cpSync(path, retained); return { path: retained, sha256: sha(readFileSync(retained)) }; };
    const reload = async (edit, failure = false) => {
      const offset = logs.length; edit(); const deadline = Date.now() + 120000;
      while (!(failure ? /schema validation failed|Schema validation failed|not valid|extra field/i : /Convex functions ready/).test(logs.slice(offset))) {
        if (backend.exitCode !== null || Date.now() > deadline) throw new Error('Reload failed; ' + scratch);
        await new Promise(r => setTimeout(r, 100));
      }
      return logs.slice(offset);
    };
    const result = await check({ scratch, root, run, client, token, url, site: 'http://127.0.0.1:3481', sha, exportFixture, reload });
    return { ...result, sourceManifest: manifest, finalSourceManifest: sourceManifest(), safetyAdapter: { level: safetySim ? 'SIM scratch-only' : 'unimplemented production registry', productionHash: productionSafetyHash, effectiveHash: existsSync(safetyRegistry) ? sha(readFileSync(safetyRegistry)) : null } };
  } finally {
    writeFileSync(join(scratch, 'backend.log'), logs);
    try { process.kill(-backend.pid, 'SIGTERM'); } catch { /* Already exited. */ }
    assert.equal(envHash(), before, 'Root deployment configuration changed');
  }
}
