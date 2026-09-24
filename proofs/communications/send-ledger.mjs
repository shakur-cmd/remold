import { open, readFile, mkdir, rmdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const A = 'shakur@envoylogic.com', B = 'reply@repliedfor.com';
const DAY = 86_400_000;
const header = { kind: 'policy', version: 1, cap: 5, windowMs: DAY, mailboxes: [A, B] };
const validIntent = (value) => typeof value.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value.id)
  && /^[a-f0-9]{64}$/.test(value.contentHash)
  && ((value.from === A && value.to === B) || (value.from === B && value.to === A));

export class SendLedger {
  constructor(path, now = Date.now) { this.path = path; this.now = now; }
  async initialize() {
    // Explicit first-use operation only. Missing state during a run never initializes itself.
    const file = await open(this.path, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(header) + '\n'); await file.sync(); }
    finally { await file.close(); }
    const directory = await open(dirname(this.path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async transaction(action) {
    const lock = this.path + '.lock';
    try { await mkdir(lock, { mode: 0o700 }); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('LEDGER_BUSY_OR_RECOVERY_REQUIRED'); throw error; }
    try {
      const raw = await readFile(this.path, 'utf8');
      let rows;
      try {
        if (!raw.endsWith('\n')) throw new Error();
        rows = raw.trimEnd().split('\n').map((line) => JSON.parse(line));
        if (JSON.stringify(rows.shift()) !== JSON.stringify(header)) throw new Error();
        const ids = new Set();
        let lastTime = 0;
        for (const row of rows) {
          if (!Number.isSafeInteger(row.at) || row.at < lastTime) throw new Error();
          lastTime = row.at;
          if (row.kind === 'reservation' && validIntent(row) && !ids.has(row.id)) ids.add(row.id);
          else if (!(row.kind === 'outcome' && ids.has(row.id) && ['accepted', 'rejected', 'unknown'].includes(row.status))) throw new Error();
        }
      } catch { throw new Error('LEDGER_CORRUPT'); }
      const at = this.now();
      if (!Number.isSafeInteger(at) || at < 0 || rows.some((row) => row.at > at)) throw new Error('CLOCK_REGRESSION');
      const { append, result } = action(rows, at);
      if (append) {
        const file = await open(this.path, 'a');
        try { await file.writeFile(JSON.stringify(append) + '\n'); await file.sync(); }
        finally { await file.close(); }
      }
      return result;
    } finally { await rmdir(lock); }
  }
  async reserve(intent) {
    if (!validIntent(intent)) throw new Error('RECIPROCAL_ONLY_OR_INVALID_INTENT');
    return this.transaction((rows, at) => {
      const previous = rows.find((row) => row.kind === 'reservation' && row.id === intent.id);
      if (previous) {
        if (['from', 'to', 'contentHash'].some((key) => previous[key] !== intent[key])) throw new Error('ATTEMPT_CONFLICT');
        return { result: { shouldDispatch: false, id: intent.id, reason: 'ALREADY_RESERVED' } };
      }
      // All reservations count, including crashes, rejection, and ambiguous provider outcomes.
      if (rows.filter((row) => row.kind === 'reservation' && row.from === intent.from && row.at > at - DAY).length >= 5) throw new Error('SEND_CAP');
      const append = { kind: 'reservation', at, id: intent.id, from: intent.from, to: intent.to, contentHash: intent.contentHash };
      return { append, result: { shouldDispatch: true, id: intent.id } };
    });
  }
  async outcome(id, status) {
    if (!['accepted', 'rejected', 'unknown'].includes(status)) throw new Error('INVALID_OUTCOME');
    return this.transaction((rows, at) => {
      if (!rows.some((row) => row.kind === 'reservation' && row.id === id)) throw new Error('NO_RESERVATION');
      return { append: { kind: 'outcome', at, id, status }, result: { recorded: true } };
    });
  }
}
