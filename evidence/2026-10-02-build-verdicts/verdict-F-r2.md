VERDICT: REVISE

I am Astra (gpt-6-astra) via Codex, independently verifying F-m7-r2 at `161f1f6` against `origin/integ/m3`. The broader integration diff was also inspected. Evidence level: SIM/local.

**Must-fix defect**

**Company totals discard required pagination-splitting signals.** `convex/invoices.ts:33` and `:55` discard `splitCursor` and `pageStatus`. A refreshed page can contribute an incomplete sum without telling `usePaginatedQuery` to split it. `src/routes/RecordPage.tsx:271` treats the final page’s exhausted status as complete.

Reproduction: create six unpaid $1 invoices; load two pages of three; insert five newer $1 invoices; refresh the first page with its original `endCursor` and `maximumRowsRead: 3`. This deliberately small budget exercises Convex’s incomplete-page protocol. The native result says `SplitRequired` with a split cursor; the invoice result drops both. Loaded summaries sum to **$6**, expected **$11**, while the last page has `isDone: true`.

The installed Convex client (`node_modules/convex/src/react/use_paginated_query.ts:328–352`) uses those signals to split and withhold incomplete results. This is a simulated read-limit case, not a claim that six ordinary invoices hit production limits.

Fix: preserve pagination metadata through both wrappers. Add a regression for reactive page growth and required splitting, including final totals after splitting completes.

Before: [probe log](/tmp/verify-F-m7-r2/probes-with-split.log), **1 failed, 3 passed**. After preserving those fields in scratch: [diagnostic log](/tmp/verify-F-m7-r2/split-diagnostic.log), **4 passed**. This proves signal preservation; browser recovery and final split totals remain unverified. No checkout fix was applied.

**Should-fix**

`src/routes/RecordPage.tsx:305–306` treats a masked paid-on value as unpaid. A paid invoice with paid-on hidden and a visible past due date is labeled overdue. Show an unknown/hidden payment status when unreadable. Source-review finding; browser rendering was not exercised.

**Verified independently**

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | Passed; already up to date |
| `pnpm typecheck` | Passed |
| `pnpm test` | 33 files, 133 tests passed |
| `pnpm test:authority` | 17 files, 99 tests passed |
| `pnpm verify:release` | 19 passed, 0 failed |
| `pnpm build` | Passed; bundle-size warning |

Logs are under `/tmp/verify-F-m7-r2/`. No timeout flakes occurred.

Every behavioral Done-when item has a passing test: mixed paid/unpaid balances, overdue disappearance after payment, and blocked agent paid-on writes. Regressions pass for 603 company records and an overdue invoice behind 1,201 paid invoices. Both earlier defects are covered and their mutations fail.

Additive/idempotent metadata migration, proposal defaults, hidden amounts and record scopes passed. Three additional probes passed: foreign-workspace company IDs rejected by both company queries; hidden paid-on suppresses totals and overdue membership; a rejected mixed amount/payment agent update changes neither record nor events. [Probe evidence](/tmp/verify-F-m7-r2/probes.log).

Schema is unchanged against the job base and rollback target `63dc87b`. Writes reuse existing record mutations and applyChange. No payment-provider or sending path was added in the job diff.

**Mutations caught / survived**

Scratch command: `node /home/shakur/work/verify/F-m7-r2/node_modules/vitest/vitest.mjs run convex/invoices.test.ts`.

| Mutation | Result |
|---|---|
| Sum unpaid invoices as paid | Caught: 3 failed |
| End totals after first page | Caught: 1 failed |
| End overdue scan after first page | Caught: 1 failed |
| Keep paid invoices overdue | Caught: 2 failed |
| Remove paid-on agent protection | Caught: 2 failed |
| Reduce display cap to five | Caught: 1 failed |

None survived. Baseline and restored code passed **8/8**. [Mutation summary](/tmp/verify-F-m7-r2/mutations-summary.txt). Initial scratch launches through pnpm were blocked by its symlinked-modules safeguard; these were infrastructure failures, not mutation results. Direct Vitest runs replaced them.

**Not verified**

No local backend was running or launched. The supplied browser harness requires absent `/usr/bin/google-chrome`; no independent UI screenshots or browser interactions were captured. Builder screenshots remain builder evidence. Production data, source PDFs, hosted limits, live reactive splitting and runtime rollback were not verified. No production/hosted calls, deployments or real email were made.

Tracked files remain unchanged; no commits were made. Scratch test copies were removed; evidence logs remain. The remaining defect requires correction and fresh independent verification.