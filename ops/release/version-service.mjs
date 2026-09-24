import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

// Real local Workers asset routing; the commit and frontend are synthetic fixtures.
const scratch = mkdtempSync(join(tmpdir(), 'remold-version-service-'));
const assets = join(scratch, 'assets');
mkdirSync(assets);
const sha = 'a'.repeat(40);
writeFileSync(join(assets, 'index.html'), '<main>Synthetic Remold frontend</main>');
writeFileSync(join(assets, 'version.json'), JSON.stringify({ sha }));
for (const name of ['_redirects', '_headers']) {
  const source = new URL(`../../public/${name}`, import.meta.url);
  if (existsSync(source)) copyFileSync(source, join(assets, name));
}
writeFileSync(join(scratch, 'wrangler.json'), JSON.stringify({ name: 'remold-version-proof', compatibility_date: '2026-09-21', assets: { directory: './assets', not_found_handling: 'single-page-application' } }));
const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'PNPM_HOME'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
env.WRANGLER_SEND_METRICS = 'false';
env.CI = '1';
let logs = '';
const child = spawn('pnpm', ['dlx', 'wrangler@4.138.0', 'dev', '--local', '--ip', '127.0.0.1', '--port', '3460', '--config', join(scratch, 'wrangler.json')], { cwd: scratch, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', b => { logs += b; });
child.stderr.on('data', b => { logs += b; });
try {
  const deadline = Date.now() + 180_000;
  while (!logs.includes('Ready on')) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Worker did not become ready: ${scratch}/worker.log`);
    await new Promise(r => setTimeout(r, 250));
  }
  for (const path of ['/version', '/version.json']) {
    for (const mode of ['cors', 'navigate']) {
      const response = await fetch(`http://127.0.0.1:3460${path}`, { headers: { 'sec-fetch-mode': mode }, signal: AbortSignal.timeout(10_000), redirect: 'manual' });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /application\/json/);
      assert.match(response.headers.get('cache-control'), /no-store/);
      assert.deepEqual(await response.json(), { sha });
    }
  }
  const home = await fetch('http://127.0.0.1:3460/o/fixture', { signal: AbortSignal.timeout(10_000) });
  assert.match(await home.text(), /Synthetic Remold frontend/);
  console.log(JSON.stringify({ result: 'PASS', level: 'SERVICE local Workers runtime; synthetic artifact', versionAndJson: true, navigationAndFetch: true, cache: 'no-store', spaFallback: true, scratch }));
} finally {
  writeFileSync(join(scratch, 'worker.log'), logs);
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
}
