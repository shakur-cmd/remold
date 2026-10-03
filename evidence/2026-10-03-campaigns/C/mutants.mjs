// Breaks one rule at a time and checks that convex/shape.test.ts notices. Run from the repo root:
// node evidence/2026-10-03-campaigns/C/mutants.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const mutants = [
  ['M1 member-role agent may propose', 'convex/shapeSuggestions.ts', 'if (principal.agent.role !== "admin") fail', 'if (false) fail'],
  ['M2 stale proposal throws instead of failing', 'convex/shapeSuggestions.ts', 'if (!stale(error)) throw error;', 'throw error;'],
  ['M3 proposer gets no read on its new object', 'convex/shapeSuggestions.ts', 'if (row.change.kind === "addObject" && agent!.authorityVersion === 1)', 'if (false)'],
  ['M4 restricted person may apply a new object', 'convex/shapeSuggestions.ts', 'if (change.kind === "addObject") return requireUnrestricted(ctx, principal);', 'if (change.kind === "addObject") return;'],
  ['M5 agent lists every agent\'s proposals', 'convex/agentApi.ts', '.eq("agentId", agent._id)', ''],
  ['M6 lookup without a slot allowed', 'convex/lib/metadata.ts', 'if (spec.type === "lookup" && used[kind] >= capacity[kind]) fail', 'if (false) fail'],
  ['M7 member-role person may apply', 'convex/shapeSuggestions.ts', 'requireWriter(ctx, args.orgId, "admin"), row', 'requireWriter(ctx, args.orgId), row'],
  ['M7b member-role person sees proposals', 'convex/shapeSuggestions.ts', 'if (principal.member.role === "member") return [];', ''],
  ['M8 apply writes no audit row', 'convex/shapeSuggestions.ts', 'await ctx.db.insert("authorityAudit", { orgId: args.orgId, actor: principal.actor, action: "shapeProposalApplied"', 'void ({ orgId: args.orgId, actor: principal.actor, action: "shapeProposalApplied"'],
  ['M9 agent may rename existing options', 'convex/shapeSuggestions.ts', 'fail("VALIDATION", "Agents can add options but not change existing ones")', 'void 0'],
  ['M10 duplicate field key allowed', 'convex/lib/metadata.ts', 'if (taken.has(spec.key)) fail("VALIDATION", "Field key already exists");', ''],
  ['M11 option removal allowed', 'convex/lib/metadata.ts', 'fail("VALIDATION", "Options cannot be removed")', 'void 0'],
  ['M12 dismiss leaves status pending', 'convex/shapeSuggestions.ts', 'status: "dismissed", resolvedBy', 'status: "pending", resolvedBy'],
];
let caught = 0;
for (const [label, file, from, to] of mutants) {
  const original = readFileSync(file, 'utf8');
  if (!original.includes(from)) { console.log(`${label}: NOT APPLIED`); continue; }
  writeFileSync(file, original.replace(from, to));
  try {
    const run = spawnSync('pnpm', ['exec', 'vitest', 'run', 'convex/shape.test.ts'], { encoding: 'utf8' });
    const summary = /Tests\s+(.*)/.exec(run.stdout)?.[1]?.trim() ?? 'no summary';
    const killed = run.status !== 0;
    if (killed) caught++;
    console.log(`${label}: ${killed ? 'CAUGHT' : 'SURVIVED'} (${summary})`);
  } finally { writeFileSync(file, original); }
}
console.log(`caught ${caught}/${mutants.length}`);
