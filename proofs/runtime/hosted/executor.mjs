// Hosted executor proof: one sandbox per run, stub model only, all spend gated by the H0 control plane.
// The sandbox has no network; its only channel is stdio to this trusted executor.
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';

export const DOCKER_CONTEXT = 'colima-remold-proof';
export const WATCH_INTERVAL_MS = 100;
const dockerEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
export const docker = (...args) => execFileSync('docker', ['--context', DOCKER_CONTEXT, ...args], { encoding: 'utf8', env: dockerEnv }).trim();

export function sandboxArgs(name, volume, image, label) {
  return ['--context', DOCKER_CONTEXT, 'run', '-i', '--rm', '--name', name, '--label', label,
    '--network', 'none',
    '--mount', `type=volume,src=${volume},dst=/work`,
    '--read-only', '--tmpfs', '/tmp:rw,size=8m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--user', '65534:65534', '--pids-limit', '64', '--memory', '128m', image];
}

// tenants: { A: { agent, adapter, volume, policy: { maxUnitsPerRun?, maxDurationMs? } } }
export function createExecutor({ call, read, image, runId, tenants }) {
  let hosted = true, count = 0;
  const running = new Set(), active = {}, effects = [], peaks = { global: 0 };
  const log = [];

  function start(tenant) {
    const name = `remold-p6-${runId}-${tenant}-${++count}`;
    const child = spawn('docker', sandboxArgs(name, tenants[tenant].volume, image, 'remold-p6=' + runId), { env: dockerEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    const box = { name, child, tenant, tokens: 0, done: null, exited: new Promise(resolve => child.on('exit', () => resolve(box.exitedAt = Date.now()))), listeners: [] };
    box.ready = new Promise((resolve, reject) => {
      child.on('exit', () => reject(new Error('sandbox exited before ready')));
      createInterface({ input: child.stdout }).on('line', line => {
        let message;
        try { message = JSON.parse(line); } catch { return; }
        if (message.ready) resolve();
        else if (message.token !== undefined) { box.tokens++; box.listeners.forEach(fn => fn(box)); }
        else if (message.done) box.done = message;
      });
    });
    box.ready.catch(() => {});
    return box;
  }

  function kill(box, reason) {
    if (box.killed || box.exitedAt) return;
    box.killed = { reason, at: Date.now() };
    // Asynchronous so one kill never stalls the watchers of other running sandboxes.
    spawn('docker', ['--context', DOCKER_CONTEXT, 'kill', box.name], { env: dockerEnv, stdio: 'ignore' }).on('error', () => {});
  }

  function track(tenant, delta) {
    peaks[tenant] = peaks[tenant] ?? 0;
    active[tenant] = (active[tenant] ?? 0) + delta;
    active.global = (active.global ?? 0) + delta;
    peaks[tenant] = Math.max(peaks[tenant], active[tenant]);
    peaks.global = Math.max(peaks.global, active.global);
  }

  async function run(tenant, { id, mode = 'normal', units, intervalMs = 50, targets, hooks = {} }) {
    const t = tenants[tenant], record = { tenant, id, mode, units, applied: false };
    log.push(record);
    if (!hosted) return Object.assign(record, { refused: 'hosted disabled' });
    // Missing cap means zero.
    const cap = t.policy.maxUnitsPerRun ?? 0;
    if (!(units <= cap)) return Object.assign(record, { refused: 'executor policy cap' });
    const box = start(tenant);
    running.add(box);
    try {
      await box.ready;
      let c, p, request;
      try {
        c = await call('claim', { token: t.agent, id, worker: box.name });
      } catch (error) { kill(box, 'refused'); return Object.assign(record, { refused: error.message }); }
      try {
        p = await call('permit', { token: t.adapter, id, ...c, worker: box.name });
        const { expires, maxUnits, maxRecipients, ...args } = p;
        request = await call('consume', { token: t.adapter, ...args });
      } catch (error) {
        kill(box, 'refused');
        // Claimed but not dispatched: release the reservation instead of holding it until expiry.
        await call('cancel', { token: t.agent, id }).catch(() => {});
        return Object.assign(record, { refused: error.message });
      }
      if (!hosted) kill(box, 'global');
      track(tenant, 1);
      record.fence = p.fence; record.step = p.step; record.maxUnits = request.maxUnits;
      const duration = t.policy.maxDurationMs ?? 0;
      const timer = setTimeout(() => kill(box, 'duration'), duration);
      box.listeners.push(b => { if (b.tokens > request.maxUnits && !b.done) kill(b, 'tokens'); });
      if (hooks.onToken) box.listeners.push(hooks.onToken);
      const watch = setInterval(async () => {
        if (!hosted) return kill(box, 'global');
        try {
          const status = await read('adapterStatus', { token: t.adapter, id, fence: p.fence, step: p.step });
          if (status.cancel) kill(box, 'cancel');
        } catch { kill(box, 'status unavailable'); }
      }, WATCH_INTERVAL_MS);
      box.child.stdin.write(JSON.stringify({ mode, maxTokens: request.maxUnits, intervalMs, targets }) + '\n');
      record.exitAt = await box.exited;
      clearTimeout(timer);
      clearInterval(watch);
      track(tenant, -1);
      record.tokens = box.tokens;
      record.killed = box.killed?.reason;
      record.killLatencyMs = box.killed ? record.exitAt - box.killed.at : undefined;
      // A killed run has no provider report; the executor's own meter is the residual. A finished
      // run must carry the provider's usage report or it stays missing and blocks further spend.
      const usage = box.killed ? box.tokens : box.done?.usage;
      record.usage = usage;
      if (hooks.beforeCheck) await hooks.beforeCheck(record);
      // The org kill switch does not mark the result late in H0, so check it before reconciling.
      let cancelled;
      try { cancelled = (await read('adapterStatus', { token: t.adapter, id, fence: p.fence, step: p.step })).cancel; } catch { cancelled = true; }
      if (hooks.beforeReconcile) await hooks.beforeReconcile(record);
      const r = await call('reconcile', { token: t.adapter, id, fence: p.fence, step: p.step, providerRef: 'stub:' + box.name, usage });
      Object.assign(record, { accepted: r.accepted, late: r.late, overrun: r.overrun, cancelledBeforeReconcile: cancelled });
      if (!box.killed && box.done && usage !== undefined && !cancelled && r.accepted && !r.late && !r.overrun) {
        record.applied = true;
        effects.push({ tenant, id, output: box.done.output });
      }
      return record;
    } finally {
      running.delete(box);
      if (!box.killed && box.child.exitCode === null) kill(box, 'cleanup');
    }
  }

  function disable() {
    hosted = false;
    for (const box of running) kill(box, 'global');
  }

  return { run, disable, effects, peaks, log, running };
}
