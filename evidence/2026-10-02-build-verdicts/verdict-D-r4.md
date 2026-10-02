VERDICT: PASS

I am Astra (gpt-6-astra) via Codex, independently verifying D-m4-r4 at `2a19bcdb1c22e58920af1556510c024a4e4dc379`, branch `m4/funnels`. Evidence level: SIM. No must-fix defect found.

Read VERIFY.md, the job brief, M4 context, builder handover and prior verdict. Inspected the reference-base diff inventory and reviewed the job changes against the merged `origin/integ/m3b` baseline.

**Must-fix defects**

None found.

**Should-fix**

- Add maintained UI behavior tests for New funnel, quick-add/done, and filter controls. Current automated coverage proves backend behavior; those interactions have builder-only browser evidence.
- Totals above 4,000 matching records remain partial (`convex/lib/list.ts:114–122`). The board discloses this (`src/components/Board.tsx:43`), but those totals cannot equal a complete export.
- Show a zero summed value explicitly when the amount field is available. `src/components/Board.tsx:67` suppresses it through a truthiness check, including when positive and negative amounts cancel.

**What I verified and how**

All required commands passed independently, exit status 0:

| Command | Summary |
| --- | --- |
| `pnpm install --frozen-lockfile` | Already up to date |
| `pnpm typecheck` | No diagnostics |
| `pnpm test` | 33 files, 157 tests passed |
| `pnpm test:authority` | 17 files, 99 tests passed |
| `pnpm verify:release` | 19 passed, 0 failed |
| `pnpm build` | Built successfully; chunk-size and plugin-timing warnings |

Logs: `/tmp/verify-D-m4-r4/{install,typecheck,test,authority,release,build}.log`. No test timeout flakes or isolated timeout reruns were needed.

Each testable Done-when item has passing checked-in coverage in `convex/funnels.test.ts`: per-stage counts and sums versus filtered exports for two funnels; two-field AND plus inclusive date range, excluding records outside it; unreadable-field rejection; migration idempotency. The prior midnight-upper-bound defect is fixed across index, filter-expression and record-scoped paths. The 1,002-step regression reaches every step once, urgent first and undated last. Client date-range tests cover local-day and DST boundaries.

Independent scratch probes passed **2/2**: a separate range oracle checked UTC, +14:00, -12:00, open ends and encoded midnight instants; access probes rejected foreign-workspace steps/totals, restricted steps and sums to allowed records, and suppressed steps/Today associations when About was hidden. An initial fixture update omitted its existing scopes and correctly received FORBIDDEN; preserving those scopes fixed the fixture. Evidence: `probes.log` and `probes-fixture-error.log`.

Job writes reuse applyChange-backed record mutations. No new external-send path or embedded credential was found in the job diff; email tests stub fetch. The job adds no schema changes relative to m3b. Release checks name rollback target `d84a95fe148d53dab6e928c6a7512f9bd8685f36`; this is not a live rollback rehearsal.

**Mutations caught/survived**

Ran `node node_modules/vitest/vitest.mjs run convex/funnels.test.ts -t <test-name> --maxWorkers=1` in the scratch copy (the first six also used `--testTimeout=30000`). All seven mutations produced relevant assertion failures:

| Mutation | Observed failure |
| --- | --- |
| Double summed amounts | Board sum 2,500 versus export 1,250 |
| Remove query-field permission check | Hidden-field query resolved instead of rejecting |
| Make upper index bound exclusive | Last-day record missing |
| Remove midnight +0.5 ms upper-bound adjustment | Midnight instant missing |
| Read steps in creation order | Undated/Future instead of Urgent first |
| Remove Today funnel associations | Empty association map |
| Change field order on each migration run | Second-run snapshot differs |

No applied mutation survived. Evidence: `mutation-*.log` and `mutations.log`. After restoring implementation files, funnel and field tests passed **34/34** (`restored.log`). These red/green logs provide before/after evidence for review.

**Could not verify**

No local backend/browser session was started, so UI interactions, rendered layout and screenshots were not independently reproduced. Builder screenshots remain builder evidence. Production migration, live-data rollback and service performance remain unverified. No production or hosted-service calls, deployment, or real email were performed.

No tracked files were edited and no commits were made. The checkout is clean. Scratch test sources and the mutation copy were removed; evidence logs and [this verdict](/tmp/verify-D-m4-r4/verdict.md) remain under `/tmp/verify-D-m4-r4`.