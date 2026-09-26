import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, symlinkSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const clientId = process.argv[2];
assert.match(clientId ?? '', /^client_[A-Za-z0-9]+$/, 'Provide the approved public staging client ID');
const scratch = mkdtempSync(join(tmpdir(), 'remold-identity-'));
const sha = value => createHash('sha256').update(value).digest('hex');
const configHash = () => existsSync(join(root, '.env.local')) ? sha(readFileSync(join(root, '.env.local'))) : null;
const beforeConfig = configHash();
const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CONVEX_AGENT_MODE: 'anonymous', CONVEX_DISABLE_METRICS: '1', CI: '1' };
const cli = join(root, 'node_modules/convex/bin/main.js');
const readyPath = join(root, 'ops/identity/evidence/local-ready.json');
let backendLog = '', frontendLog = '', backend, frontend, stopping = false;
const pause = ms => new Promise(r => setTimeout(r, ms));
async function ready(check, name) {
  const until = Date.now() + 180_000;
  while (!await check()) {
    if (backend.exitCode !== null || Date.now() > until) throw new Error(`${name} failed; logs: ${scratch}`);
    await pause(200);
  }
}
const stop = () => {
  if (stopping) return; stopping = true;
  for (const child of [frontend, backend]) if (child) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
  writeFileSync(join(scratch, 'backend.log'), backendLog);
  writeFileSync(join(scratch, 'frontend.log'), frontendLog);
  assert.equal(configHash(), beforeConfig, 'Root environment changed');
};
process.on('SIGTERM', () => { stop(); process.exit(0); });
process.on('SIGINT', () => { stop(); process.exit(0); });
try {
  for (const name of ['convex', 'src', 'public']) cpSync(join(root, name), join(scratch, name), { recursive: true, filter: p => !p.endsWith('.test.ts') && !p.endsWith('test.helpers.ts') && !p.endsWith('test.setup.ts') });
  for (const name of ['package.json', 'index.html', 'vite.config.ts', ...readdirSync(root).filter(name => /^tsconfig.*\.json$/.test(name))]) cpSync(join(root, name), join(scratch, name));
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir');
  const authSource = readFileSync(join(root, 'convex/auth.config.ts'), 'utf8');
  writeFileSync(join(scratch, 'convex/auth.config.ts'), 'export default { providers: [] };\n');
  backend = spawn(process.execPath, [cli, 'dev', '--typecheck', 'disable', '--tail-logs', 'disable', '--local-cloud-port', '3450', '--local-site-port', '3451'], { cwd: scratch, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  backend.stdout.on('data', b => { backendLog += b; }); backend.stderr.on('data', b => { backendLog += b; });
  await ready(() => /Convex functions ready/.test(backendLog), 'Initial isolated backend');
  const localEnv = readFileSync(join(scratch, '.env.local'), 'utf8');
  assert.equal(/^(?:VITE_)?CONVEX_URL=(.+)$/m.exec(localEnv)?.[1], 'http://127.0.0.1:3450');
  execFileSync(process.execPath, [cli, 'env', 'set', 'WORKOS_CLIENT_ID', clientId], { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  const offset = backendLog.length;
  writeFileSync(join(scratch, 'convex/auth.config.ts'), authSource);
  await ready(() => /Convex functions ready/.test(backendLog.slice(offset)), 'WorkOS JWT validation');
  const frontendEnv = { ...env, VITE_CONVEX_URL: 'http://127.0.0.1:3450', VITE_WORKOS_CLIENT_ID: clientId, VITE_WORKOS_REDIRECT_URI: 'http://localhost:5173/callback', VITE_ROUTER: 'browser' };
  frontend = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), '--host', 'localhost', '--port', '5173', '--strictPort'], { cwd: scratch, env: frontendEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  frontend.stdout.on('data', b => { frontendLog += b; }); frontend.stderr.on('data', b => { frontendLog += b; });
  await ready(async () => { try { return (await fetch('http://localhost:5173', { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } }, 'Isolated frontend');
  assert.equal(configHash(), beforeConfig);
  const evidence = { status: 'READY FOR REAL SIGN-IN; NOT VERIFIED', scratch, frontend: 'http://localhost:5173', backend: 'http://127.0.0.1:3450', site: 'http://127.0.0.1:3451', publicStagingClientId: clientId, rootEnvironmentUnchanged: true, authConfigHash: sha(authSource), serverApiKeyUsed: false, sourceRootSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() };
  writeFileSync(readyPath, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence));
  await new Promise((_, reject) => {
    backend.once('exit', code => reject(new Error(`Backend exited ${code}`)));
    frontend.once('exit', code => reject(new Error(`Frontend exited ${code}`)));
  });
} finally { stop(); }
