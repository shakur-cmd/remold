// Breaks one automation rule at a time and checks that convex/automations.test.ts notices.
// Run from the repo root: node evidence/2026-10-03-campaigns/I/mutants.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const A = 'convex/automations.ts', L = 'convex/lib/automation.ts';
const mutants = [
  ['M1 agent may turn an automation on', 'convex/authority/agentGuards.ts', "if (field === automation && to === 'on') fail", 'if (false) fail'],
  ['M2 editing an on automation keeps it on', L, 'if (was === "on" && values[status._id] === "on" && edited) values[status._id] = validated[status._id] = "paused";', ''],
  ['M3 turning on skips the completeness check', L, 'await check(ctx, automation.object.orgId, definitionOf(automation, values), values[status._id] === "on");', 'await check(ctx, automation.object.orgId, definitionOf(automation, values), false);'],
  ['M4 delete actions not refused by name', L, 'if (/delete|remove|archive|destroy/i.test(action.type)) bad', 'if (false) bad'],
  ['M5 gated status writes allowed', L, 'if (GATED.includes(item.object.key) && key === "status") bad', 'if (false) bad'],
  ['M6 more than 10 actions allowed', L, 'if (d.actions.length > 10) bad', 'if (false) bad'],
  ['M7 fieldChanged fires without a real change', L, '!!field && !same(before?.[field._id], after[field._id]) && matches', '!!field && matches'],
  ['M8 recordCreated also fires on update', L, 'd.when === "recordCreated" ? action === "create" &&', 'd.when === "recordCreated" ? true &&'],
  ['M9 no dedupe by key', L, 'if (await ctx.db.query("automationRuns").withIndex("by_key", (q) => q.eq("key", run.key)).first()) return;', ''],
  ['M10 a retried run executes again', A, 'if (run.status === "queued") await step(ctx, run);', 'await step(ctx, run);'],
  ['M11 a run sets itself off again', L, 'if (!automation || from?.chain.includes(state.automationId)) continue;', 'if (!automation) continue;'],
  ['M12 chains allowed 4 deep', L, 'export const DAY = 86_400_000, MAX_DEPTH = 3;', 'export const DAY = 86_400_000, MAX_DEPTH = 4;'],
  ['M13 missing cap means 100', A, 'process.env.REMOLD_AUTOMATION_DAILY_CAP?.trim() || 0', 'process.env.REMOLD_AUTOMATION_DAILY_CAP?.trim() || 100'],
  ['M14 no per-automation cap', A, 'const PER_AUTOMATION = 200;', 'const PER_AUTOMATION = 100000;'],
  ['M15 runs as the person even after their access changed', A, 'member: { ...member, authorityEpoch: state.epoch }', 'member'],
  ['M16 runs in a read-only workspace', A, 'if (org && !org.flags?.readonly && user && member)', 'if (org && user && member)'],
  ['M17 refused run does not pause', A, '    return pause(ctx, automation, item, state, `Automation "${d.name}" paused: ${reason}. Turn it on again to run it as you.`);', '    return;'],
  ['M18 pauses after 4 failures', A, 'if (state.failures + 1 >= 3) await pause', 'if (state.failures + 1 >= 4) await pause'],
  ['M19 a success does not reset failures', A, '  await ctx.db.patch(state._id, { failures: 0 });\n', ''],
  ['M20 pause leaves no inbox item', A, '  await ctx.db.insert("agentInbox", { orgId: automation.orgId, text, source: "automation"', '  void ({ orgId: automation.orgId, text, source: "automation"'],
  ['M21 a failed action keeps earlier writes', A, 'if (write) fail(((error as any)?.data?.code as ErrorCode) ?? "VALIDATION", message);', 'if (write) { problems.push(message); continue; }'],
  ['M22 one job per run', L, 'if (!over && !waiting) await ctx.scheduler', 'if (!over) await ctx.scheduler'],
  ['M23 no recovery of a dead queue', A, 'if (!stuck.has(run.automationId)) { stuck.add', 'if (false) { stuck.add'],
  ['M24 schedule fires for a time before it was on', A, 'now < at || at < state.enabledAt)', 'now < at)'],
  ['M25 dateReached offset backwards', A, 'const day = today - (d.offsetDays ?? 0) * DAY', 'const day = today + (d.offsetDays ?? 0) * DAY'],
  ['M26 weekly ignores the weekday', A, '(schedule.weekday !== undefined && new Date(today).getUTCDay() !== schedule.weekday) || ', ''],
  ['M27 writes not attributed to the automation', A, 'actor: { kind: "automation", id: automation._id }, reason:', 'actor: { kind: "automation", id: "automation" }, reason:'],
  ['M28 created ids not kept in history', A, 'await finish("done", undefined, created);', 'await finish("done");'],
  ['M29 dry run hides problems', A, '      problems.push(message);\n', ''],
];
let caught = 0;
for (const [label, file, from, to] of mutants) {
  const original = readFileSync(file, 'utf8');
  if (!original.includes(from)) { console.log(`${label}: NOT APPLIED`); continue; }
  writeFileSync(file, original.replace(from, to));
  try {
    const run = spawnSync('pnpm', ['exec', 'vitest', 'run', 'convex/automations.test.ts'], { encoding: 'utf8' });
    const summary = /Tests\s+(.*)/.exec(run.stdout)?.[1]?.trim() ?? 'no summary';
    const killed = run.status !== 0;
    if (killed) caught++;
    console.log(`${label}: ${killed ? 'CAUGHT' : 'SURVIVED'} (${summary})`);
  } finally { writeFileSync(file, original); }
}
console.log(`caught ${caught}/${mutants.length}`);
