import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SendLedger } from './send-ledger.mjs';

const A = 'shakur@envoylogic.com', B = 'reply@repliedfor.com';
const intent = (id, from = A, to = B) => ({ id, from, to, contentHash: 'a'.repeat(64) });
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'remold-send-ledger-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'ledger.jsonl');
  let time = 1_000_000;
  const clock = () => time;
  const ledger = new SendLedger(path, clock);
  await ledger.initialize();
  return { path, ledger, clock, advance: (ms) => { time += ms; } };
}

test('five uncertain attempts consume a mailbox allowance across restart', async (t) => {
  const f = await setup(t);
  for (let i = 0; i < 5; i++) assert.equal((await f.ledger.reserve(intent(`p${i}`))).shouldDispatch, true);
  await f.ledger.outcome('p0', 'rejected');
  await f.ledger.outcome('p1', 'accepted');
  const restarted = new SendLedger(f.path, f.clock);
  await assert.rejects(restarted.reserve(intent('sixth')), /SEND_CAP/);
  assert.equal((await restarted.reserve(intent('other', B, A))).shouldDispatch, true);
});
test('same attempt never dispatches again, and cannot change its recipient or content', async (t) => {
  const { ledger } = await setup(t);
  await ledger.reserve(intent('same'));
  assert.equal((await ledger.reserve(intent('same'))).shouldDispatch, false);
  await assert.rejects(ledger.reserve({ ...intent('same'), contentHash: 'b'.repeat(64) }), /ATTEMPT_CONFLICT/);
  await assert.rejects(ledger.reserve(intent('self', A, A)), /ROUTE_NOT_ALLOWED/);
  await assert.rejects(ledger.reserve(intent('third', A, 'third@example.com')), /ROUTE_NOT_ALLOWED/);
});
test('concurrent independent ledgers cannot reserve more than five', async (t) => {
  const { path, clock } = await setup(t);
  const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) =>
    new SendLedger(path, clock).reserve(intent(`concurrent${i}`))));
  assert.ok(results.filter((r) => r.status === 'fulfilled').length <= 5);
  for (let i = 0; i < 5; i++) {
    try { await new SendLedger(path, clock).reserve(intent(`fill${i}`)); } catch (error) {
      assert.match(error.message, /SEND_CAP/);
    }
  }
  await assert.rejects(new SendLedger(path, clock).reserve(intent('overflow')), /SEND_CAP/);
});
test('rolling window expires reservations; a backwards clock refuses new sends', async (t) => {
  const f = await setup(t);
  for (let i = 0; i < 5; i++) await f.ledger.reserve(intent(`p${i}`));
  f.advance(-1);
  await assert.rejects(f.ledger.reserve(intent('clock')), /CLOCK_REGRESSION/);
  f.advance(86_400_002);
  assert.equal((await f.ledger.reserve(intent('nextday'))).shouldDispatch, true);
});
test('missing or corrupt durable state fails closed', async (t) => {
  const { path, ledger } = await setup(t);
  await appendFile(path, '{partial');
  await assert.rejects(ledger.reserve(intent('corrupt')), /LEDGER_CORRUPT/);
  await rm(path);
  await assert.rejects(ledger.reserve(intent('missing')), /ENOENT/);
});
