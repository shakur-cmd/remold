VERDICT: REVISE

I am Claude Fable 5.1 (claude-fable-5-1), independently verifying I-m10 round 3 at `bb339db0d4f72aafad22e65ef97485dd3a81cd9d` on `m10/first-customer`. I did not build it.

All suites pass and every round-2 finding is closed as far as the in-memory simulator (convex-test) can show. This round I also ran the code on the cached local Convex backend, which enforces real transaction limits. Three things that pass in the simulator fail there, and all three are must-fix. Nothing in the branch charges money, publishes or emails.

Evidence levels: suites and mutations are **SIM**. The limit probes are **SERVICE** (local Convex backend `precompiled-2026-09-28`, loopback only, synthetic sign-in). Nothing is SANDBOX or LIVE.

## Must-fix

### 1. An export inside the stated limit cannot be imported once it has about 4,000 records

- **Where:** `convex/workspace.ts:158-181` (`importAll` inserts each record blank, then patches it).
- **Cause:** each `ctx.db.patch` counts as a read. Convex allows 4,096 reads per function, so the limit is hit by record count, far below `MAX_ROWS = 15000`.
- **Input and output on the local backend:**

| Workspace | Export | Import of that export into a fresh workspace |
| --- | --- | --- |
| 3,000 people (6,051 rows) | ok | ok |
| 4,000 people (8,051 rows) | ok | `Function execution timed out (maximum duration: 1s)`; log warns `Many reads (actual: 4000, limit: 4096)` |
| 4,200 people (8,451 rows) | ok | `Too many reads in a single function execution (limit: 4096)` at `workspace.ts:179` |
| 7,470 people (14,991 rows) | ok, 3.6 MB | same `Too many reads` error |

- **Why it matters:** the brief's item 1 is export then import. The gate document marks "Restore from an export, all or nothing" as done, and the terms tell owners to keep their own export. An owner with 4,000 to 7,400 records gets a file that cannot be restored, and learns it only when restoring.
- **Why the tests miss it:** the 15,000-row test passes because convex-test enforces no limits.
- **Suggested fix:** write each record once with its final values (allocate ids first without a patch, or order inserts so targets exist), or stage the import across mutations with a final publish step. Then set the row limit from what the local backend actually accepts, and add a check that runs export and import at that limit on the local backend (the `ops/authority/local.mjs` harness already does this kind of run).

### 2. A workspace holding more than about 16 MiB of stored data can be neither exported nor deleted

- **Where:** `convex/workspace.ts:44-47` (`snapshot` reads every record and event) and `:196` (the DELETE WITHOUT EXPORT path calls `snapshot` first and rethrows anything that is not the size refusal).
- **Input:** 3,000 people, each with 3 KB of text in one field (about 9 MB of text, stored twice because the create event keeps a copy).
- **Wrong output:**
  - `exportAll`: `Server Error … Too many bytes read in a single function execution (limit: 16777216 bytes)`.
  - `confirmDelete` with `DELETE WITHOUT EXPORT` and the right name: the same server error. The workspace stays.
- **Why it matters:** this is round-2 must-fix 2 again for byte-heavy workspaces. `/terms` and `/privacy` say an owner can delete at any time. A CRM with a few thousand notes or logged emails reaches this size.
- **Thin margin below that:** stored bytes run about twice the export JSON. A 7.02 MB export read roughly 14 MB, and an export refused cleanly at 7 MiB had already read 14.0 MB and 15.0 MB of the 16.8 MB allowed. More history per record, or text in indexed fields, pushes a workspace under 7 MiB of JSON over the read limit, where the owner sees a raw server error.
- **Suggested fix:** the no-export path must not depend on reading the whole workspace. Decide "too large to export" from a bounded read (stop counting rows and bytes at a budget well under the limits) and let the phrase through when that budget is exceeded. Use the same bounded check in `exportAll` so the refusal is always the clean message. Lower the byte limit to match the measured ratio.

### 3. Deletion never finishes for a workspace with about 5,000 integration parents

- **Where:** `convex/workspace.ts:209-211` (`under` now walks every parent with no bound) and the purge loop at `:227-234`.
- **Cause:** the round-3 fix removed the 100-parent cap by walking all parents in one mutation, one index read per parent.
- **Input:** a small workspace with 5,000 `safetyTargets` and no receipts; export, `confirmDelete` with the sha256.
- **Wrong output:** `workspace:purge` fails with `Your request timed out performing too many system operations`. After 180 s the workspace still had `deletingAt` set and its records, events, objects and safety targets in place. The hourly resume cron would start the same failing step again.
- **Thresholds measured:** 1,000 and 2,500 targets finish; 5,000 does not.
- **Reach:** integrations are gated off in production today, so no live workspace has these rows. I rate it must-fix for the same reason as in round 2: the brief requires bounded batches, and a stuck purge leaves every remaining row of the workspace in the database permanently.
- **Suggested fix:** have each parent step delete a bounded number of parents together with their children (children first, in the same or a following bounded step), or carry a cursor over parents between runs. Test with several thousand childless parents on the local backend.

## Should-fix

- **`purge` on a workspace that is not being deleted is not tested.** Changing `if (!org?.deletingAt) return` to `if (!org) return` passes all tests. That guard is the only thing stopping `workspace:purge` from deleting a live workspace if it is ever called with the wrong id.
- **Export does not have a test for counting link values, and neither byte limit has a test.** Three mutants survive: export ignoring link values, export without the 7 MiB check, import without the 7 MiB check.
- **The delete form's wiring for the phrase is untested.** Sending the phrase as `sha256` instead of `withoutExport` (`src/components/WorkspaceCards.tsx:66`) passes all tests. The cards are still only rendered statically.
- **"7 MiB" is measured in characters, not bytes** (`workspace.ts:71`, `:84` use `.length`). Non-Latin text is up to three times larger in bytes.
- **Import time.** Even at 3,000 people the import took 5.3 s wall time on this machine, and 4,000 hit the 1 s user-code timeout before the read limit. Hosted timing will differ; measure it when fixing must-fix 1.
- **Carried over from round 2, accepted as stated by the builder:** the timeline rescans a record's history on every page; Stripe subscriptions are not cancelled on deletion (now a pending gate row).

## What I verified and how

I read `VERIFY.md`, the job brief, `AGENTS.md`, the handover (all three rounds), `verdict-r1.md`, `verdict-r2.md`, the round-3 ruling and the builder's mutant log. I reviewed the round-3 diff (`7bc1e59..HEAD`) in full and the M10 diff against `origin/integ/m3b`.

| Command | My result |
| --- | --- |
| `pnpm install --frozen-lockfile` | exit 0 (pnpm 11.23.0) |
| `pnpm typecheck` | exit 0 |
| `pnpm test --maxWorkers=2 --testTimeout=15000` | 39 files, 188 passed |
| `pnpm test:authority --maxWorkers=2 --testTimeout=15000` | 17 files, 99 passed |
| `pnpm verify:release` | 42 passed, 0 failed |
| `pnpm build` | exit 0, built in 1.21s |
| `node limits.mjs` (my probe, local Convex backend) | 12 scenarios; results above and below |

No test flaked.

**Round-2 findings, rechecked:**

| Finding | State now |
| --- | --- |
| Must-fix 1: purge left children of late parents | Closed in the simulator (mutant caught), but the fix introduced must-fix 3 above. |
| Must-fix 2: 4,000-row limit blocked export and deletion | Partly closed. Row-count overflow now works on the local backend: 7,480 people refused export cleanly and were deleted with the phrase. Byte overflow is must-fix 2 above; import is must-fix 1. |
| Checkout activation too loose | Closed. Mode, payment status and price each have a caught mutant. |
| Import ignored link values in the limit | Closed. Mutant caught. |
| Rollback gate passed an unreadable backup | Closed. Mutant caught. |
| Stripe not cancelled on deletion | Tracked as a pending gate row, checked by `gate.test.mjs`. |
| Four surviving mutants | All four now caught. |
| Failed purge never retried | Closed: hourly `resumeDeletions`. Mutant caught. |
| User rows kept | Now stated on `/privacy`. Mutant caught. |
| Handover format | `handover.html` added. |

**Local-backend results that passed:**

- 3,000 people: export, import, delete with sha256, purge to empty.
- 7,470 people (14,991 rows): export in 9.7 s, delete with sha256, purge to empty.
- 7,480 people: export refused with the clean message, phrase deletion works, purge to empty.
- 2,000 people with 1.5 KB text each (7.02 MB export): export, import, delete all work.
- 2,000 people with 3 KB text each: clean refusal, phrase deletion works.

**Other checks:**

- **Schema and rollback:** `convex/schema.ts` is identical at `a315d89` and HEAD; `a315d89` is an ancestor and is named in `ops/release/notes.json`. No schema change this round.
- **Billing:** still off unless `REMOLD_BILLING=test`; live keys and live-mode events refused; signature verified; all four mutants caught.
- **Secrets:** a pattern scan of `convex`, `src`, `ops`, `docs` and `packages` for Stripe and Resend key shapes found none. This is not a full audit.
- **Tree:** I edited no tracked files and made no commits; `git status` is clean. Scratch copies are restored and match the checkout.

## Mutations

43 mutants, each applied alone in a scratch copy and restored (`/tmp/verify-I-m10-r3/mut` for vitest, `/tmp/verify-I-m10-r3/clone` for node tests).

**Caught (38):**

- **Purge (8):** `under()` capped at 100 parents; cursors before their lookups; safety targets before their receipts; bindings before callbacks; batch unbounded; org row kept; members skipped; resume handler does nothing.
- **Limits and deletion confirm (6):** import ignoring link values; row limit 15,001; phrase accepted while exportable; any phrase accepted; name not checked; sha256 not checked.
- **Export and import (3):** restricted owner allowed; admins allowed; import writes no `links` rows.
- **Fence (1):** `currentPrincipal` ignoring `deletingAt`.
- **Billing (8):** mode, payment status and price unchecked; `metadata[price]` not sent; `apply` ignoring `deletingAt`; live key accepted; live-mode events accepted; signature not verified.
- **Legal and Settings (7):** 15,000-row sentence removed; sign-in identity sentence removed; draft marker removed; data card shown to every role; billing card dropped; lowercase phrase enables delete; help text loses the phrase.
- **Rollback gate and gate document (5):** unreadable backup passes; `deletingAt` ignored (caught by `deploy.test.mjs`); stripe-cancel row removed; stripe-cancel row marked done; export-limit sentence removed.

**Survived (5):**

| Mutation | Meaning |
| --- | --- |
| `purge` runs on a workspace without `deletingAt` | Real gap; see should-fix |
| Export does not count link values | Real gap |
| Export has no byte limit | Real gap |
| Import has no byte limit | Real gap |
| Delete form sends the phrase as `sha256` | Real gap in UI wiring |

## What I could not verify

- Hosted Convex. The local backend enforces the same documented limits, but timing (the 1 s user-code timeout, the "too many system operations" timeout) depends on the machine, so the exact thresholds on hosted Convex may differ.
- Simultaneous imports under real OCC.
- Real Stripe test-mode delivery and the Checkout request against Stripe.
- The Settings cards in a browser with a signed-in session.
- A deployed rollback to `a315d89`, or the gate against a real backup.
- Legal wording, price, live billing and the remaining gate rows stay pending with Shakur.

Files are in `/tmp/verify-I-m10-r3`:

- verdict.md
- limits.mjs
- limits-run1.log
- limits.log
- limits-backend-run1.log
- limits-backend.log
- mutations.log
- mutations.json
- test.log
- authority.log
- release.log
- build.log
