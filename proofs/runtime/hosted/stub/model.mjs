// Deterministic stub model that runs inside the tenant sandbox. No inference, no network.
// Protocol: one JSON job line on stdin; JSON lines out: ready, token*, done.
import { createInterface } from 'node:readline';
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';

const out = value => process.stdout.write(JSON.stringify(value) + '\n');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function walk(dir, found, depth = 0) {
  if (depth > 12 || ['/proc', '/sys', '/dev'].includes(dir)) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const path = (dir === '/' ? '' : dir) + '/' + entry.name;
    if (entry.isDirectory()) walk(path, found, depth + 1);
    else if (entry.name.startsWith('tenant-secret-')) found.push(path);
  }
}

function reach(host, port) {
  return new Promise(resolve => {
    const socket = connect({ host, port, timeout: 1500 });
    const done = ok => { socket.destroy(); resolve(ok); };
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

async function probe(job) {
  const secrets = [];
  walk('/', secrets);
  const readable = secrets.map(path => { try { return { path, text: readFileSync(path, 'utf8').trim() }; } catch { return { path, text: null }; } });
  const reachable = [];
  for (const target of job.targets) if (await reach(target.host, target.port)) reachable.push(target);
  let rootWritable = true;
  // /var/tmp is world-writable in the image, so only a read-only root filesystem stops this write.
  try { writeFileSync('/var/tmp/remold-p6-write-test', 'x'); } catch { rootWritable = false; }
  const hostPaths = ['/Users', '/home/urkel', '/root/.claude', '/root/.codex', '/root/.config', '/var/run/docker.sock', '/run/docker.sock'].filter(path => { try { statSync(path); return true; } catch { return false; } });
  return {
    secrets: readable,
    reachable,
    interfaces: Object.keys(networkInterfaces()),
    env: Object.keys(process.env).sort(),
    uid: process.getuid(),
    rootWritable,
    hostPaths,
    ownWorkspace: existsSync('/work') ? readdirSync('/work') : null,
  };
}

const lines = createInterface({ input: process.stdin });
out({ ready: true });
for await (const line of lines) {
  const job = JSON.parse(line);
  if (job.mode === 'probe') { out({ done: true, output: JSON.stringify(await probe(job)), usage: 0 }); break; }
  const limit = job.maxTokens;
  if (job.mode === 'overshoot') {
    // Ignores the token limit it was given, in one burst.
    for (let i = 0; i < limit + 5; i++) out({ token: 't' + i });
    await wait(5000);
    out({ done: true, output: 'OVERSHOOT', usage: limit + 5 });
    break;
  }
  if (job.mode === 'hang') { out({ token: 't0' }); await wait(60000); break; }
  for (let i = 0; i < limit; i++) { await wait(job.intervalMs); out({ token: 't' + i }); }
  out(job.mode === 'noUsage' ? { done: true, output: 'STUB_OK' } : { done: true, output: 'STUB_OK', usage: limit });
  break;
}
process.exit(0);
