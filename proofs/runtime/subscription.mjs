import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const dir = fileURLToPath(new URL('./', import.meta.url));
const live = process.argv.includes('--run-authorized-smoke');
const evidence = `${dir}evidence/${live ? 'lifecycle' : 'preflight'}.json`;
const ledger = `${dir}evidence/inference-started.json`;
// Never inherit API keys, provider endpoints, or unrelated service credentials.
const env = Object.fromEntries(['PATH', 'HOME', 'USER', 'TMPDIR'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
const events = [], pending = new Map(), notices = [];
let sequence = 0, child, closed = false;
const started = Date.now();
const record = (kind, data) => events.push({ ms: Date.now() - started, kind, ...data });
function request(method, params = {}) {
  const id = ++sequence;
  record('request', { id, method });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}
function event(method, predicate = () => true, timeout = 60000) {
  const existing = notices.find(n => n.method === method && predicate(n.params));
  if (existing) return Promise.resolve(existing.params);
  return new Promise((resolve, reject) => {
    const listener = { method, predicate, resolve, reject };
    listener.timer = setTimeout(() => { listeners.delete(listener); reject(new Error(`Missing event: ${method}`)); }, timeout);
    listeners.add(listener);
  });
}
const listeners = new Set();
const result = { scope: 'owner-local subscription CLI feasibility only', cliVersion: '0.156.1', startedAt: new Date().toISOString(), live, marginalDollarCost: 'unknown', environmentKeys: Object.keys(env), limits: { concurrentTurns: 1, maximumTurns: 2, processWallMs: 100000, successTurnMs: 60000, interruptAfterFirstTextOrMs: 5000, interruptedCompletionMs: 10000 }, events };
await mkdir(`${dir}evidence`, { recursive: true });
await mkdir(`${dir}empty-workspace`, { recursive: true });
if (live) {
  // Refuse accidental repeated subscription usage. A fresh budget needs a new owner decision.
  await writeFile(ledger, JSON.stringify({ startedAt: result.startedAt, allowance: 'one short completion plus one bounded interruption' }, null, 2) + '\n', { flag: 'wx' });
}
const disabledFeatures = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'remote_plugin', 'browser_use', 'browser_use_external', 'computer_use', 'in_app_browser', 'in_app_local_automation', 'image_generation', 'multi_agent', 'multi_agent_v2', 'hooks', 'shell_snapshot', 'code_mode_host', 'skill_search', 'skill_mcp_dependency_install', 'tool_suggest'];
const args = ['app-server', '--listen', 'stdio://', '-c', 'web_search="disabled"', '-c', 'forced_login_method="chatgpt"', ...disabledFeatures.flatMap(x => ['--disable', x])];
child = spawn('codex', args, { cwd: `${dir}empty-workspace`, env, stdio: ['pipe', 'pipe', 'pipe'] });
child.on('exit', (code, signal) => { closed = true; record('exit', { code, signal }); });
child.stderr.on('data', data => {
  // Persist only diagnostic categories, never arbitrary environment/config values.
  const lines = String(data).split('\n').filter(Boolean);
  record('stderr', { lineCount: lines.length, categories: lines.map(line => line.includes('ERROR') ? 'error' : line.includes('WARN') ? 'warning' : 'diagnostic') });
});
createInterface({ input: child.stdout }).on('line', line => {
  let msg;
  try { msg = JSON.parse(line); } catch { record('nonJson', {}); return; }
  const waiter = pending.get(msg.id);
  if (waiter) {
    clearTimeout(waiter.timer); pending.delete(msg.id);
    record('response', { id: msg.id, ok: !msg.error, error: msg.error });
    msg.error ? waiter.reject(new Error(JSON.stringify(msg.error))) : waiter.resolve(msg.result);
  } else if (msg.id !== undefined && msg.method) {
    // This text-only test never approves a tool or supplies an auth token.
    record('unexpectedServerRequest', { method: msg.method });
    child.stdin.write(`${JSON.stringify({ id: msg.id, error: { code: -32601, message: 'Text-only feasibility client refuses server requests' } })}\n`);
  } else if (msg.method) {
    notices.push(msg);
    const p = msg.params ?? {};
    record('notification', { method: msg.method, threadId: p.threadId, turnId: p.turnId ?? p.turn?.id, status: p.turn?.status, itemType: p.item?.type, text: msg.method === 'item/agentMessage/delta' ? p.delta : undefined, tokenUsage: p.tokenUsage });
    for (const listener of [...listeners]) if (listener.method === msg.method && listener.predicate(p)) {
      clearTimeout(listener.timer); listeners.delete(listener); listener.resolve(p);
    }
  }
});
const killTimer = setTimeout(() => child.kill('SIGKILL'), result.limits.processWallMs);
try {
  // Real negative baseline: protocol must refuse account operations before handshake.
  let refused = false;
  try { await request('account/read', { refreshToken: false }); } catch (e) { refused = /Not initialized/.test(String(e)); }
  assert(refused, 'Pre-handshake account access must fail');
  result.preHandshakeRefused = refused;
  const init = await request('initialize', { clientInfo: { name: 'remold_runtime_feasibility', version: '0.1.0' } });
  result.handshake = { userAgent: init.userAgent, platformFamily: init.platformFamily, platformOs: init.platformOs };
  child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
  const account = await request('account/read', { refreshToken: false });
  result.account = { type: account.account?.type, planType: account.account?.planType, requiresOpenaiAuth: account.requiresOpenaiAuth };
  assert.equal(result.account.type, 'chatgpt', 'Only existing managed ChatGPT sign-in is permitted');
  const { config } = await request('config/read', { includeLayers: false, cwd: `${dir}empty-workspace` });
  result.configured = { model: config.model, provider: config.model_provider, effort: config.model_reasoning_effort, serviceTier: config.service_tier };
  assert.equal(config.model, 'gpt-6-luna', 'Configured model changed since preflight; stop without substituting');
  assert([null, 'openai'].includes(config.model_provider));
  if (live) {
    const overrides = { web_search: 'disabled' };
    for (const name of Object.keys(config.mcp_servers ?? {})) overrides[`mcp_servers.${name}.enabled`] = false;
    for (const name of Object.keys(config.plugins ?? {})) overrides[`plugins.${name}.enabled`] = false;
    result.disabledMcpCount = Object.keys(config.mcp_servers ?? {}).length;
    const thread = await request('thread/start', { cwd: `${dir}empty-workspace`, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true, config: overrides, baseInstructions: 'This is a synthetic text-only runtime test. Never use tools, read files, browse, or write files. Answer only the requested text.', developerInstructions: 'No tools or external actions. Do not inspect the workspace or credentials.' });
    result.thread = { id: thread.thread.id, ephemeral: thread.thread.ephemeral, model: thread.model, provider: thread.modelProvider, reasoningEffort: thread.reasoningEffort, sandbox: thread.sandbox, approvalPolicy: thread.approvalPolicy };
    assert.equal(thread.model, config.model);
    assert.equal(thread.modelProvider, 'openai');
    assert.equal(thread.sandbox.type, 'readOnly');
    assert.equal(thread.sandbox.networkAccess, false);
    const threadId = thread.thread.id;
    const turn = await request('turn/start', { threadId, input: [{ type: 'text', text: 'Reply exactly RUNTIME_OK. Do not use any tools.', text_elements: [] }] });
    const complete = await event('turn/completed', p => p.turn.id === turn.turn.id, result.limits.successTurnMs);
    assert.equal(complete.turn.status, 'completed');
    const output = notices.filter(n => n.method === 'item/agentMessage/delta' && n.params.turnId === turn.turn.id).map(n => n.params.delta).join('');
    assert.equal(output.trim(), 'RUNTIME_OK');
    result.completion = { turnId: turn.turn.id, status: complete.turn.status, output, usage: notices.filter(n => n.method === 'thread/tokenUsage/updated' && n.params.turnId === turn.turn.id).at(-1)?.params.tokenUsage ?? null };
    const interruption = await request('turn/start', { threadId, input: [{ type: 'text', text: 'For this synthetic interruption test only, write the word blue on 500 separate lines. Start immediately. Use no tools.', text_elements: [] }] });
    let streamObserved = false;
    try { await event('item/agentMessage/delta', p => p.turnId === interruption.turn.id, result.limits.interruptAfterFirstTextOrMs); streamObserved = true; } catch { /* Interrupt even when the first token has not arrived. */ }
    const interruptAt = Date.now();
    await request('turn/interrupt', { threadId, turnId: interruption.turn.id });
    const stopped = await event('turn/completed', p => p.turn.id === interruption.turn.id, result.limits.interruptedCompletionMs);
    assert.equal(stopped.turn.status, 'interrupted');
    result.interruption = { turnId: interruption.turn.id, streamObserved, status: stopped.turn.status, acknowledgementToTerminalMs: Date.now() - interruptAt, usage: notices.filter(n => n.method === 'thread/tokenUsage/updated' && n.params.turnId === interruption.turn.id).at(-1)?.params.tokenUsage ?? null };
    assert.equal(events.filter(e => e.kind === 'unexpectedServerRequest').length, 0);
    const toolItems = events.filter(e => e.itemType && !['userMessage', 'agentMessage', 'reasoning'].includes(e.itemType));
    assert.deepEqual(toolItems, [], 'The model must perform no tools or file writes');
    result.toolItems = toolItems.length;
    result.status = 'local text lifecycle passed; full P6 remains blocked';
  } else result.status = 'handshake and subscription preflight passed; no inference';
} catch (error) {
  result.status = 'failed; no automatic retry'; result.error = String(error); process.exitCode = 1;
} finally {
  clearTimeout(killTimer);
  for (const listener of listeners) clearTimeout(listener.timer);
  for (const waiter of pending.values()) clearTimeout(waiter.timer);
  if (!closed) { child.kill('SIGTERM'); await new Promise(resolve => { child.once('exit', resolve); setTimeout(() => { if (!closed) child.kill('SIGKILL'); resolve(); }, 1000).unref(); }); }
  result.durationMs = Date.now() - started;
  await writeFile(evidence, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ evidence, status: result.status, error: result.error, configured: result.configured, completion: result.completion, interruption: result.interruption, durationMs: result.durationMs }, null, 2));
}
