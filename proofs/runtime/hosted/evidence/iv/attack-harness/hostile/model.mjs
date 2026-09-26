// Independent-verifier probe guest. Same stdio protocol as the builder stub (ready, token*, done).
// No inference, no API calls. It only reports what the sandbox lets a hostile tenant observe, so the
// verifier can confirm the container boundary holds. Every attempt is caught and reported, never fatal.
import { createInterface } from 'node:readline';
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { spawnSync } from 'node:child_process';

const out = v => process.stdout.write(JSON.stringify(v) + '\n');
const wait = ms => new Promise(r => setTimeout(r, ms));
const rd = p => { try { return readFileSync(p, 'utf8').slice(0, 2000); } catch (e) { return 'ERR:' + e.code; } };
const wr = (p, s = 'x') => { try { writeFileSync(p, s); return 'WROTE'; } catch (e) { return 'ERR:' + e.code; } };
const ex = p => { try { statSync(p); return true; } catch { return false; } };
const sh = c => { const r = spawnSync('sh', ['-c', c], { encoding: 'utf8', timeout: 5000 }); return { out: ((r.stdout || '') + (r.stderr || '')).trim().slice(0, 800), status: r.status }; };

function reach(host, port) {
  return new Promise(resolve => {
    const s = connect({ host, port, timeout: 300 });
    const done = v => { try { s.destroy(); } catch {} resolve(v); };
    s.on('connect', () => done('CONNECTED'));
    s.on('timeout', () => done('timeout'));
    s.on('error', e => done('ERR:' + e.code));
  });
}

async function report(job) {
  // Filesystem: find any tenant secret in the plausible surface, probe host mounts and the docker socket.
  // Kept shallow and targeted so the whole probe finishes inside the executor lease.
  const found = [];
  const walk = (d, depth) => {
    if (depth > 4 || ['/proc', '/sys', '/dev', '/usr', '/lib'].includes(d)) return;
    let e; try { e = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of e) {
      const p = (d === '/' ? '' : d) + '/' + it.name;
      if (it.isDirectory()) walk(p, depth + 1);
      else if (it.name.startsWith('tenant-secret-')) found.push({ path: p, text: rd(p).trim() });
    }
  };
  walk('/', 0);
  for (const d of ['/work', '/host', '/mnt', '/data', '/root', '/home']) walk(d, 0);

  // Genuine host-leak indicators only. /etc/hostname and an empty /mnt are normal inside any container.
  const hostPaths = ['/Users', '/home/urkel', '/root/.claude', '/root/.codex', '/root/.config',
    '/var/run/docker.sock', '/run/docker.sock', '/host/etc', '/hostfs'].filter(ex);

  const writes = {
    rootEtc: wr('/etc/remold-escape'),
    varTmp: wr('/var/tmp/remold-escape'),
    work: wr('/work/remold-escape'),
    tmp: wr('/tmp/remold-escape'),
    proc: wr('/proc/sysrq-trigger', '0'),
  };

  // Network pivots by IP literal only (a no-network sandbox blocks DNS, so hostname reaches would just
  // stall on getaddrinfo and prove nothing new; interfaces:[lo] already shows there is no route out).
  const nets = [
    ...(job.targets || []),
    { host: '127.0.0.1', port: 3940 },
    { host: '169.254.169.254', port: 80 },
    { host: '::1', port: 3940 },
  ];
  const netResults = {};
  // IP literals only, in parallel. Hostname reaches are omitted on purpose: a no-network sandbox has no
  // resolver, and a pending getaddrinfo would keep a libuv handle alive for seconds. interfaces:[lo]
  // and every IP reach failing already prove there is no route off the sandbox.
  await Promise.all(nets.map(async t => { netResults[`${t.host}:${t.port}`] = await reach(t.host, t.port); }));

  return {
    tenant: job.tenant,
    uid: process.getuid(),
    gid: process.getgid(),
    interfaces: Object.keys(networkInterfaces()),
    secretsFound: [...new Map(found.map(s => [s.path, s])).values()],
    hostPaths,
    writes,
    caps: rd('/proc/self/status').split('\n').filter(l => /^Cap/.test(l)),
    mounts: rd('/proc/mounts').split('\n').filter(l => /docker|work|host|Users/.test(l)).slice(0, 8),
    envLeak: Object.keys(process.env).filter(k => /TOKEN|KEY|SECRET|CONVEX|ANTHROPIC|OPENAI|CLAUDE|CODEX|REMOLD|ADMIN/i.test(k)),
    net: netResults,
  };
}

const lines = createInterface({ input: process.stdin });
out({ ready: true });
for await (const line of lines) {
  const job = JSON.parse(line);
  if (job.mode === 'probe' || job.mode === 'hostile') {
    out({ done: true, output: JSON.stringify(await report(job)), usage: 0 });
    break;
  }
  // Forge cross-tenant ids on stdout and over-report tokens beyond the limit.
  if (job.mode === 'forge') {
    for (let i = 0; i < (job.maxTokens || 1); i++) { await wait(job.intervalMs || 20); out({ token: 't' + i, tenant: 'A-FORGED', usage: 999999 }); }
    out({ done: true, output: 'FORGED', usage: 999999, tenant: 'A-FORGED' });
    break;
  }
  if (job.mode === 'underreport') {
    // Consume the full token budget of real compute but self-report only 1 unit.
    for (let i = 0; i < (job.maxTokens || 1); i++) { await wait(job.intervalMs || 10); out({ token: 't' + i }); }
    out({ done: true, output: 'STUB_OK', usage: 1 });
    break;
  }
  if (job.mode === 'overreport') {
    for (let i = 0; i < (job.maxTokens || 1); i++) { await wait(job.intervalMs || 10); out({ token: 't' + i }); }
    out({ done: true, output: 'STUB_OK', usage: 999 });
    break;
  }
  if (job.mode === 'oversize') {
    out({ token: 'big', payload: 'Z'.repeat(5_000_000) });
    out({ done: true, output: 'Z'.repeat(20_000_000), usage: 1 });
    break;
  }
  const limit = job.maxTokens;
  for (let i = 0; i < limit; i++) { await wait(job.intervalMs); out({ token: 't' + i }); }
  out({ done: true, output: 'STUB_OK', usage: limit });
  break;
}
process.exit(0);
