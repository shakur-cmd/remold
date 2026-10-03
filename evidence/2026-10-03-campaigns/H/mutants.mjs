// Deliberate breaks of the batch code; each must make convex/batches.test.ts fail.
// Run from the repo root: node evidence/2026-10-03-campaigns/H/mutants.mjs
// The 1000-item test is left out of mutant runs for time; it runs in the normal suite.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const mutants = [
  ['no conflict check', 'convex/lib/conflicts.ts', '  for (const id of keys) if (', '  for (const id of [] as string[]) if ('],
  ['link delta replaces links', 'convex/batches.ts', 'values[id] = joined(record?.values[id], delta);', 'values[id] = delta.add;'],
  ['suggestion link delta replaces links', 'convex/suggestions.ts', 'values[id] = joined(record?.values[id], delta);', 'values[id] = delta.add;'],
  ['step re-reads applied items', 'convex/batches.ts', 'q.eq("batchId", batch._id).eq("status", "queued")).take(', 'q.eq("batchId", batch._id)).take('],
  ['direct batch needs only proposal scope', 'convex/agentApi.ts', 'const allowed = (ids: string[]) => direct ? recordGranted(', 'const allowed = (ids: string[]) => false ? recordGranted('],
  ['no agent guard at submit', 'convex/agentApi.ts', 'agentGuard(principal, object, result.item.fields, result.record, input.action === "delete" ? "delete" : result.merged);', ''],
  ['everyone sees every batch', 'convex/batches.ts', 'async function visible(ctx: QueryCtx, principal: Principal, batch: Doc<"batches">) {', 'async function visible(ctx: QueryCtx, principal: Principal, batch: Doc<"batches">) { return true;'],
  ['impact ignores links rows', 'convex/batches.ts', '.filter((row: Doc<"links">) => row.fromRecordId !== record._id).length;', '.filter(() => false).length;'],
  ['no idempotent replay', 'convex/agentApi.ts', 'direct = !!args.direct, prior = await replay(ctx, principal.agent._id, args.idempotency);', 'direct = !!args.direct, prior = null as any;'],
  ['events lose the batch', 'convex/events.ts', 'batchId: item?.batchId ?? null,', 'batchId: null,'],
  ['item forgets its event', 'convex/batches.ts', '...(result.eventId ? { eventId: result.eventId } : {})', '...{}'],
  ['adopting drops link deltas', 'convex/suggestions.ts', '  if (links) await ctx.db.insert("suggestionLinks"', '  if (false) await ctx.db.insert("suggestionLinks"'],
  ['agent is the actor of a proposal', 'convex/batches.ts', '{ approvedBy: actors.approver, actor: actors.approver.actor }', '{ approvedBy: actors.approver }'],
  ['only the first bad item reported', 'convex/agentApi.ts', 'errors.push({ index, code: data.code, message: data.message ?? data.code });', 'if (!errors.length) errors.push({ index, code: data.code, message: data.message ?? data.code });'],
  ['invalid items dropped, not refused', 'convex/agentApi.ts', '  if (errors.length) fail(errors[0]!.code', '  if (false) fail(errors[0]!.code'],
  ['a failing chunk ends the run', 'convex/batches.ts', '    catch { single = CHUNK; }', '    catch { return; }'],
  ['read only does not stop', 'convex/batches.ts', '  if (org.flags?.readonly) return { stop: "Workspace is read only" };', ''],
  ['revoked agent may be applied', 'convex/batches.ts', '  if (paused(await ctx.db.get(batch.agentId), batch)) fail(', '  if (false) fail('],
  ['duplicate records allowed', 'convex/agentApi.ts', 'if (seen.has(recordId)) fail(', 'if (false) fail('],
  ['any agent reads a batch', 'convex/agentApi.ts', ' || batch.agentId !== principal.agent._id) fail("NOT_FOUND", "Batch not found");', ') fail("NOT_FOUND", "Batch not found");'],
  ['apply while counting', 'convex/batches.ts', '  if (batch.counting) fail("CONFLICT"', '  if (false) fail("CONFLICT"'],
  ['round 2: archived create accepted at submit', 'convex/agentApi.ts', '      if (input.action === "create") requireLive(object);', ''],
  ['round 2: suggestions keep their own stale rule', 'convex/suggestions.ts', 'const conflicts = await staleFields(ctx, suggestion.change.action, record!, suggestion.before, Object.keys(suggestion.change.values));', 'const conflicts = (Object.keys(suggestion.before).length ? [] : []) as any[];'],
  ['no size limit', 'convex/agentApi.ts', 'export const MAX_BATCH = 1000;', 'export const MAX_BATCH = 100000;'],
  // Each reverts one fix from the independent review (Astra findings 1-7).
  ['review 1: person writes alone, cascades skip agent limits', 'convex/batches.ts', 'applyChange(ctx, actors.agent, change, actors.approver ? { approvedBy: actors.approver, actor: actors.approver.actor } : {})', 'applyChange(ctx, actors.approver ?? actors.agent, change, {})'],
  ['review 2: revocation stops direct batches only', 'convex/batches.ts', '  if (paused(doc, batch)) return { stop:', '  if (batch.mode === "direct" && paused(doc, batch)) return { stop:'],
  ['review 3: field seen on some records counts', 'convex/batches.ts', 'if (field && (!object || !everywhere(principal, object, field))) return false;', 'if (field && (!object || !canReadField(principal, object, field))) return false;'],
  ['review 4: conflicts unmasked', 'convex/batches.ts', 'byId.has(c.fieldId) && everywhere(principal, object, byId.get(c.fieldId)!) ? [c] : []', '[c]'],
  ['review 5: raw title in summary', 'convex/agentApi.ts', 'title = "{record}";', 'title = first.record?.title || "a record";'],
  ['review 6: own cleanup counts as a conflict', 'convex/lib/conflicts.ts', ' && !(action === "delete" && await cleared(ctx, fields.find((f) => f._id === id), before[id], record.values[id]))', ''],
  ['review 7: agent told the impact', 'convex/agentApi.ts', 'reason: batch.reason, total: batch.total, counts: batch.counts, progress: progressOf(batch),', 'reason: batch.reason, total: batch.total, counts: batch.counts, impact: batch.impact, progress: progressOf(batch),'],
];
const results = [];
// Slices keep each run short: node mutants.mjs <from> <to> runs mutants[from..to) and prints one line each.
// --bail stops at the first failing test, since one is enough to call a mutant caught.
const [from = 0, to = mutants.length] = process.argv.slice(2).map(Number);
let restore = null;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { restore?.(); process.exit(1); });
for (const [name, file, before, after] of mutants.slice(from, to)) {
  const original = readFileSync(file, 'utf8');
  if (original.split(before).length !== 2) { results.push(`AMBIGUOUS ${name}`); console.log(results.at(-1)); continue; }
  writeFileSync(file, original.replace(before, after)); restore = () => writeFileSync(file, original);
  try {
    const run = spawnSync('pnpm', ['vitest', 'run', 'convex/batches.test.ts', '--testTimeout=30000', '--bail=1', '-t', '^(?!.*takes 1000 changes)'], { encoding: 'utf8', timeout: 420000 });
    const line = (run.stdout + run.stderr).split('\n').find((l) => /Tests\s/.test(l))?.trim() ?? (run.error ? 'run timed out' : 'no summary');
    results.push(`${run.status === 0 ? 'SURVIVED' : 'caught  '} ${name}: ${line}`);
  } finally { restore(); restore = null; }
  console.log(results.at(-1));
}
