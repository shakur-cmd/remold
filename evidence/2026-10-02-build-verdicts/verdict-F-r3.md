VERDICT: PASS

I am Astra (gpt-6-astra) via Codex, independently verifying F-m7-r3 at `420fc2d26637cd7761c6795b18c9dbf3dc29b8fe`. Evidence level: **SIM/local**. This verdict covers the tracking-only invoice job, not production readiness.

**Must-fix defects:** None found.

**Should-fix:** No new defect found. Add browser coverage for reactive page splitting when a local backend is available; the current regression proves the server protocol and split arithmetic, not the React hook end to end.

**Verified independently**

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | Exit 0; already up to date |
| `pnpm typecheck` | Exit 0 |
| `pnpm test` | Exit 0; 34 files, 155 tests passed |
| `pnpm test:authority` | Exit 0; 17 files, 99 tests passed |
| `pnpm verify:release` | Exit 0; 19 passed, 0 failed |
| `pnpm build` | Exit 0; built successfully; bundle-size warning |

No timeout flakes or reruns were needed for these commands. Logs are in `/tmp/verify-F-m7-r3/`.

Every behavioral Done-when item has passing regression coverage in `convex/invoices.test.ts`: hand-summed mixed paid/unpaid company balances, overdue removal after payment, and rejected agent paid-on writes. Additional passing coverage includes additive/idempotent metadata migration, proposal defaults, hidden amounts, record scopes, totals beyond 500 invoices, and an overdue invoice behind 1,201 paid invoices.

The previous round's defects are covered: both queries retain required page-splitting signals, split-page totals equal the complete hand sum, and hidden payment dates receive an explicit hidden status. The status helper is tested in `src/lib/invoices.test.ts`.

Three additional independent probes passed:

- Foreign-workspace company IDs are rejected by both company queries; foreign overdue invoices stay absent; cross-workspace lookup writes fail.
- Rejected mixed amount/paid-on updates and deletion of a paid invoice by an agent leave the record and attributed events unchanged.
- Mixed per-record field scopes hide only the restricted row's payment status, suppress its overdue membership, and return unknown totals.

Probe command: `node /home/shakur/work/verify/F-m7-r3/node_modules/vitest/vitest.mjs run convex/invoices.test.ts -t 'independent verifier probes'` in the scratch copy. Result: **3 passed**. An initial probe fixture omitted required `hiddenFieldIds`; that fixture error was corrected before the successful run. Both logs are retained.

Reviewed the invoice diff against merged base `origin/integ/m3b` (`4005bb1`), with original `origin/integ/m3` and broader integration diffs retained. Schema and release notes are unchanged from M3b; schema is also byte-identical to named rollback target `d84a95f`. Invoice writes reuse existing mutations/applyChange. No payment-provider, sending path, or secret was found in the invoice additions. Email tests stub network calls.

**Mutations caught / survived**

Scratch command: `node /home/shakur/work/verify/F-m7-r3/node_modules/vitest/vitest.mjs run convex/invoices.test.ts src/lib/invoices.test.ts --maxWorkers=2`.

| Deliberate breakage | Failing tests |
|---|---:|
| Sum unpaid invoices as paid | 3 |
| Keep paid invoices overdue | 2 |
| Remove paid-on agent protection | 2 |
| End totals after the first page | 2 |
| Drop totals page-splitting signals | 1 |
| Drop overdue page-splitting signals | 1 |
| Omit hidden-payment row flags | 1 |
| Ignore hidden payment status in UI helper | 1 |

**All eight were caught; none survived.** Baseline and restored implementation each passed **12/12**. Before/after evidence is retained in `mutations-summary.txt` and the corresponding logs. Removing split signals reproduces `expected undefined to be 'SplitRequired'`; restoring them passes.

**Could not verify**

No local Convex backend was running or launched. No independent company-page screenshot, Mark paid browser interaction, or live React pagination split was captured. Builder screenshots remain builder evidence. Production data, invoice PDFs, hosted limits, runtime rollback, and full M3 certification are outside this verification. No production/hosted service calls, deployments, or real email were made.

Tracked files remain unchanged; no commits were made. Scratch test copies were removed; evidence logs remain.