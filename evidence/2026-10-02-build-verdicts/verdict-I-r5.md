VERDICT: PASS

I am Claude Fable 5.1 (claude-fable-5-1), independently verifying I-m10 round 5 at `cd37db01f48b88d1a0167e47aac6f3d542977ca7` on `m10/first-customer`. I did not build it.

Both round-4b must-fix defects and the `importAll` should-fix are closed, and I found no new must-fix. Nothing in the branch charges money, publishes or emails. The should-fix list below is real and mostly carried from round 4b; the round-5 prompt put those items out of scope.

Evidence levels: suites, probes and mutations are **SIM** (convex-test, vitest, node). The import and orphan runs are **SERVICE** (isolated local Convex backend, loopback, synthetic sign-in and data). Nothing is SANDBOX or LIVE.

## Must-fix

None.

## Round-4b findings, rechecked

| Finding | State | My evidence |
| --- | --- | --- |
| Must-fix 1: byte-heavy exports could not be imported (write-rate refusal) | Closed | SERVICE, table below |
| Must-fix 2: a failed import could leave a hidden workspace forever | Closed | SERVICE and SIM, below |
| Should-fix: `importAll` checked neither caller nor file owner | Closed | SIM probe R2, mutants |

**Must-fix 1 (SERVICE, my runs on this machine).** Same fixture shape as round 4b: companies with 4.5 KB of notes and one create event each.

| Code | Export | Import result |
| --- | --- | --- |
| HEAD | 8.0 MB | ok, 11 s, 850 records and 850 events re-exported |
| HEAD | 31.1 MB | ok, 43 s, 3,300 and 3,300 |
| HEAD | 33.1 MB (31.6 MiB, just under the 32 MiB cap) | ok, 48 s, 3,520 and 3,520 |
| HEAD with pacing and retry removed from `send` (scratch copy) | 31.1 MB | fails in 2.1 s: `Too many writes per second. Your deployment is limited to 4 MiB bytes written per 1 second.` at `workspace.ts:366` |

- The backend log shows no write-rate refusal in any HEAD run.
- The unpaced variant is the failing-first evidence the builder could not produce on their machine; here the limit binds.
- The builder's 149 s for 33.1 MB was 48 s here. Either way it is far inside the 10-minute action limit.
- The stated import limit ("up to 32 MB and 25,000 records, history entries and links" on `/privacy` and in the gate document) is proven for bytes by the 33.1 MB run. The 25,000-row part rests on my round-4b run (38 s); I did not repeat it.

**Must-fix 2.**

- **SERVICE:** I planted two staging workspaces through a verifier-only fixture, then ran the real `workspace:resumeDeletions` through the CLI.
  - The 16-minute-old one (450 records) was purged to empty.
  - The 9-minute-old one was left untouched.
  - `workspace:abortImport` on a live workspace was refused ("not being imported").
  - `workspace:abortImport` on the 9-minute-old one purged it to empty; the live workspace kept its rows.
- **SIM (R3):** `importStart` plus `importRecords`, then nothing, then the cron after 61 minutes leaves no rows. A late `importPublish` from the dead import is refused once the cron has marked the workspace.
- **SIM (R10):** another user can neither publish nor abort someone else's staging workspace. Purging B's stale staging workspace leaves A's row counts and A's export file unchanged.
- **Rollback gate:** unchanged. It still waits while a backup shows `importingAt`; the cron clears an orphan within about 75 minutes.

**`importAll` should-fix (SIM, R2 and R4).**

- A signed-out caller, another signed-in user, and a non-creator with the creation gate closed are each refused on `importAll` and on `importUploaded` for A's export file. The file still exists afterwards, and B gains no workspace.
- A refused (non-JSON) import of the caller's own upload removes only that upload, creates no workspace, and leaves the export file and its registry row in place.

## Should-fix

New this round:

- **Nothing in the suites fails if the import stops pacing or retrying.**
  - `stage` without `pace`, `stage` without `withRetry`, a 100x budget, batches counted once, and `BATCH_BYTES` back at 2 MB all pass every test.
  - The two new unit tests exercise `pacer` and `withRetry` alone. Only `ops/workspace/limits.mjs` (`ONLY=bigimport`) covers the wiring; it is not part of any suite and passed on the builder's machine before the fix.
  - Fix: give `stage` an injectable clock and sleep, and assert in SIM that a multi-batch import waits and that a thrown "Too many writes" is retried.
- **The pacer banks unlimited credit** (`convex/workspace.ts:150-153`).
  - It paces the average since the import started, so after a slow byte-light stretch (or a 32 s retry wait) the following batches go out back to back.
  - SIM probe R1: after a 60 s stall, 20 counted MiB go out in the first second against a 1.5 MiB/s budget.
  - On SERVICE I could not make it fail: 14,000 light records followed by 3,000 heavy ones (15.3 MB), and 12,000 light records followed by 5,800 heavy events (28.3 MB), both imported. The backend log shows no refusal, but I do not know that it records refusals the retry absorbs.
  - Fix: cap the credit at about one second of budget.
- **Uploads that are never imported are never removed** (R5).
  - A registered upload still exists after 25 hours and a cron run. The same holds when the action is killed before its `finally`, and for uploads never registered.
  - Each is a full copy of a workspace's data that survives deleting that workspace, while `/privacy` says deletion removes the workspace's data.
  - `workspaceFiles` now makes this easy: have the hourly cron drop `upload` rows older than an hour, as `dropFile` does for exports.
- **The Settings import button's new `importUploaded` call has no test.** Removing `await uploaded({ storageId })` from `src/components/WorkspaceCards.tsx:65` passes every test, yet every import from the UI would then be refused. The cards have still never been driven in a signed-in browser.
- **Smaller test gaps (surviving mutants):** a staging step allowed after the workspace is marked deleting (my R3 covers the real code); `importUploaded` without the creation gate or the storage-existence check; `dropFile` leaving the registry row or the stored file.

Carried from round 4b, not addressed (the builder says so), re-confirmed where I reran them:

- **Export silently truncates above 1,000 objects or 1,000 fields** (`convex/workspace.ts:73-74`). R7: a workspace with 1,043 fields exports 1,000 with no error.
- **Rows written after the purge cursor has passed their table outlive the workspace** (`convex/workspace.ts:464`). R6: one `opsEvents` row remains after the org row is gone.
- **Record order changes on a round trip with a forward link.** R8: "one", "two" re-exports as "two", "one".
- **The 64 MB export cap is unproven** against hosted Convex's action memory limit.
- **Surviving mutants from round 4b:**
  - a failed import never calling `importAbort` (the cron now cleans up after it)
  - import without slot projections
  - publish without freezing authority
  - publish without the audit row
  - export file never scheduled for dropping
  - deletion without pausing integration work
- **Accepted as stated:** the timeline rescans a record's history per page; Stripe subscriptions are not cancelled on deletion (pending gate row).

## What I verified and how

I read `VERIFY.md`, the job brief, `AGENTS.md`, the handover (all five rounds), `verdict-r4b.md` and `round5-prompt.txt`. I reviewed `840c3bc..HEAD` in full and re-read `convex/workspace.ts` at HEAD. `VERIFY.md`'s base is far behind this branch, so I used the brief's base `origin/integ/m3b` (49 files, +2,848 −39).

| Command | My result |
| --- | --- |
| `pnpm install --frozen-lockfile` | exit 0 |
| `pnpm typecheck` | exit 0 |
| `pnpm test --maxWorkers=2 --testTimeout=15000` | 39 files, 196 passed |
| `pnpm test:authority --maxWorkers=2 --testTimeout=15000` | 17 files, 99 passed |
| `pnpm verify:release` | 42 passed, 0 failed |
| `pnpm build` | exit 0, built in 1.19s |

No test flaked.

- **Brief items:** export, import, deletion, legal pages, billing and the gate document are unchanged in behaviour since round 4b apart from the round-5 fixes. I did not re-run the round-4b mutation sweep for billing, legal or the rollback gate; billing code is untouched this round.
- **Deletion isolation:** the two-workspace test now also seeds `workspaceFiles` and checks that A's export file leaves storage while B's stays. Both purge mutants for that table are caught.
- **Schema and rollback:**
  - The round-5 change is one new table, `workspaceFiles`, so it is additive.
  - `ca4bf32` is an ancestor of HEAD and is named in `ops/release/notes.json`.
  - Its `convex/schema.ts` is identical to HEAD's and differs from `a4f3091` only by that table.
  - Its own suite in a scratch extract: 35 files, 151 passed; `tsc -b` and `tsc --noEmit -p convex` exit 0. `pnpm typecheck` itself would not run there against a symlinked `node_modules`.
- **Handover:** lists the env vars (five billing, three optional limits), says plainly that nothing charges money, and `handover.html` includes round 5.
- **Secrets:** a pattern scan of the lines added this round for Stripe, Resend and AWS key shapes and private-key blocks found none. This is not a full audit.
- **Tree:** I edited no tracked files and made no commits; `git status` is clean at `cd37db0`. Scratch copies are restored and match the checkout.

The mutation sweep was running during the unpaced SERVICE run and part of the HEAD run, so the timings are on a loaded machine.

## Mutations

36 mutants this round, each applied alone in a scratch copy and restored, run against `convex/workspace.test.ts` and `src/components/WorkspaceCards.test.tsx`: 19 caught, 17 survived. One more is proven on SERVICE only.

**Caught (19):**

- **Pacing helpers (3):** pacer never waits; `withRetry` never retries; `withRetry` retries our own errors.
- **Orphans (6):** cron ignores stale staging; cron marks but does not schedule the purge; cron marks a running import (threshold 0); threshold 5 minutes; `abortImport` accepts a live workspace; `abortImport` does not schedule the purge.
- **Upload ownership (8):** any user may read a registered upload; export files importable; unregistered files importable; `importUpload` without the creation gate; a registered file re-registered by anyone; `exportEnd` not registering the export; `dropUpload` keeping the stored file; `importAll` never dropping the upload.
- **Purge (2):** skips `workspaceFiles`; leaves export files in storage.

**Survived (17):**

| Mutation | Meaning |
| --- | --- |
| `stage` sends without pacing | Real gap in the suites; with retry also removed it fails on SERVICE (table above) |
| `stage` sends without retry | Real gap |
| Pacer budget 100x | Real gap |
| Batches not counted twice | Real gap |
| `BATCH_BYTES` back to 2 MB | Real gap |
| Staging step allowed after the workspace is marked deleting | Gap; my R3 shows the real code refuses |
| `importUploaded` without the creation gate | Minor: `importUploadUrl` and `importAll` are gated |
| `importUploaded` without the storage-existence check | Minor |
| `dropFile` leaves the registry row | Minor |
| `dropFile` leaves the stored file | Real gap |
| Export file never scheduled for dropping | Carried |
| Failed import never calls `importAbort` | Carried; the cron now cleans up |
| Import writes no slot projections | Carried |
| Publish does not freeze authority | Carried |
| Publish writes no audit row | Carried |
| Deletion does not pause integration work | Carried, minor |
| UI does not register the upload before import | Real gap |

## What I could not verify

- Hosted Convex: the write-rate limit for the production plan, timing, and action memory at 64 MB.
- Whether the retry ever fired in my SERVICE runs; the backend log shows no refusal.
- An import killed by the 10-minute action limit; I planted the orphans through a fixture instead.
- The 25,000-row import, the 62 MB export, the 10,000-record round trip and the 10,000-parent purge this round; the round-4b runs stand.
- Simultaneous imports under real OCC, and two `importAll` calls on the same upload.
- The Settings cards in a signed-in browser, including the upload, register, import sequence.
- Real Stripe test-mode delivery and the Checkout request against Stripe.
- A deployed rollback to `ca4bf32`, or the gate against a real backup.
- Legal wording, price, live billing and the remaining gate rows stay pending with Shakur.

Files are in `/tmp/verify-I-m10-r5`:

- verdict.md
- verifier.test.ts, probe.log (SIM probes R1 to R10)
- svc/ops/workspace/vr5.mjs, svc/ops/workspace/vr5b.mjs, svc/ops/workspace/vfixture.ts (SERVICE probes)
- svc-head-big.log, svc-nopace-big.log, svc-head-orphan-burst.log, svc-head-burst-records.log
- mutate.mjs, mutate.out, mutations.json, mutations.log
- target-test.log (rollback target suite)
- install.log, typecheck.log, test.log, authority.log, release.log, build.log
