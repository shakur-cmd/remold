VERDICT: REVISE

I am Claude Fable 5.1 (claude-fable-5-1), independently verifying I-m10 round 4b at `840c3bcc129616422a891496f8db3d952d85a6ce` on `m10/first-customer`. I did not build it.

Round 4 is now really built: staged export, staged import, marker-only delete and cursor purge are all there, all suites pass, and the three round-3 defects are closed on the local Convex backend. Two new defects in import block a PASS. Both showed up when I imported the builder's own byte-heavy fixture, which the builder exported but never imported. Nothing in the branch charges money, publishes or emails.

Evidence levels: suites, probes and mutations are **SIM** (convex-test, vitest, node). The size runs are **SERVICE** (isolated local Convex backend, loopback, synthetic sign-in and data). Nothing is SANDBOX or LIVE.

## Must-fix

### 1. An export with a few MB of text cannot be imported, though the stated limit is 32 MB

- **Where:** `convex/workspace.ts:340-353` (`stage` sends record and event batches back to back) and `:21` (`BATCH_BYTES` 2 MB).
- **Cause:** the backend refuses more than 4 MiB written per second per deployment. Batches of 300 records at 4.5 KB each exceed that rate.
- **Input:** the builder's "large" fixture shape (companies with 4.5 KB of notes, one create event each), exported, then imported with `workspace:importAll`. Two attempts per size, 5 s apart.

| Export | Import result (both attempts) |
| --- | --- |
| 31.1 MB (3,300 companies) | `Too many writes per second. Your deployment is limited to 4 MiB bytes written per 1 second.` at `workspace.ts:342` |
| 15.5 MB (1,650 companies) | same error |
| 8.0 MB (850 companies) | same error |

- **Still claimed:** `/privacy` says an export file can be imported "up to 32 MB"; the gate document marks restore as done with the same limit.
- **Why the builder missed it:** `ops/workspace/limits.mjs` exports the 30 MB workspace and deletes it, but only imports the 4.8 MB workspace of short records. That one works: 10,000 records in 29 s, and 25,000 rows in 38 s in my runs.
- **Suggested fix:** pace the staged writes by bytes (stay well under 4 MiB per second) and retry `TooManyWrites` with backoff in every step. Add the 30 MB import to `limits.mjs`, and state the import limit that run proves.

### 2. A failed import can leave a hidden workspace that nothing ever removes

- **Where:** `convex/workspace.ts:356-358` (cleanup happens only in the action's `catch`) and `:424-426` (`resumeDeletions` looks only at `deletingAt`).
- **SERVICE evidence:** in the 15.5 MB run above, the first attempt failed at `workspace.ts:358`, inside `importAbort` itself, which hit the same write-rate limit. Over a minute later a second workspace named "Big15" still held rows in `orgs`, `members`, `objects`, `fields` and `records`. `orgs:mine` showed the owner only the original.
- **SIM evidence:** calling `importStart` and `importRecords`, then nothing (as when the action times out or the backend restarts), then the hourly cron after 25 hours, leaves `{fields: 43, members: 1, objects: 8, orgs: 1, records: 1}`.
- **Why it matters:**
  - A partial copy of a customer's data stays in the database, invisible to its owner, who cannot delete it.
  - `importAbort` needs the importing user's session and token, and `purge` needs `deletingAt`, so an operator has no function to clear it either.
  - The rollback gate (`ops/deploy/prod.mjs:59`) refuses while any backup shows `importingAt`, so one orphan blocks `deploy:prod --ref` to the rollback target until someone edits production data by hand.
- **Why the tests miss it:** removing the `importAbort` call from `stage` passes all tests (the builder noted this survivor).
- **Suggested fix:** have the hourly cron mark any workspace whose `importingAt` is older than the action time limit as deleting and purge it. Test it with a staging workspace left without an abort.

## Should-fix

- **`importAll` checks nothing about who calls it or whose file it reads** (`workspace.ts:361-371`). It takes any storage id, and the `finally` deletes that file whatever happens.
  - A signed-out caller given an export's storage id got an error, and the owner's export file was gone.
  - A different signed-in user given workspace A's export storage id got a new workspace and read "A SECRET PERSON" through `records.search`.
  - With workspace creation closed, a non-creator was refused, and the file was still deleted.
  - Reach is limited: the id is unguessable and is returned only to the exporting owner. Fix: check sign-in and the creation gate first, and accept only files that user uploaded.
- **Export silently truncates above 1,000 objects or 1,000 fields** (`workspace.ts:68-69`, `take(MAX_DEFINITIONS)`). A workspace with 1,043 fields exported 1,000 with no error. Import refuses such a file. Refuse cleanly at export.
- **Rows written after the purge cursor has passed their table outlive the workspace** (`workspace.ts:415`). After the purge reached `records`, the operator command `ops:setFlag` on that workspace left one `opsEvents` row once the org row was gone. The round-3 purge rescanned from the first table and did not have this gap. Do one last pass from step 0 before deleting the org row.
- **Record order changes on a round trip when an earlier record links to a later one** (`workspace.ts:217-228`). Tasks created as "one", "two", with "one" then blocked by "two", re-export as "two", "one". The brief's test is "re-export equals the original modulo ids", and this fails it under the builder's own comparator. Lists sort by `updatedAt`, which is preserved, so the visible effect is small.
- **The 64 MB export cap is unproven on hosted Convex.** The action holds the whole file in memory at least twice. Convex documents a 64 MiB memory limit for actions in its default runtime; I could not check whether the local backend enforces it. Check on a scratch deployment before the legal pages promise 64 MB.
- **Test gaps (surviving mutants):** import without slot projections; publish without freezing authority; publish without the audit row; export file never dropped; deletion without pausing integration work.
- **Carried from earlier rounds, accepted as stated:** the timeline rescans a record's history per page; Stripe subscriptions are not cancelled on deletion (pending gate row); uploads that never reach `importAll` stay in storage.

## What I verified and how

I read `VERIFY.md`, the job brief, `AGENTS.md`, the handover (all rounds), the four earlier verdicts and the round prompts. I reviewed `bb339db..HEAD` in full and re-read `convex/workspace.ts` at HEAD. `VERIFY.md`'s base is far behind this branch, so I used the brief's base `origin/integ/m3b` (49 files, +2,632 −39).

| Command | My result |
| --- | --- |
| `pnpm install --frozen-lockfile` | exit 0, already up to date |
| `pnpm typecheck` | exit 0 |
| `pnpm test --maxWorkers=2 --testTimeout=15000` | 39 files, 191 passed |
| `pnpm test:authority --maxWorkers=2 --testTimeout=15000` | 17 files, 99 passed |
| `pnpm verify:release` | 42 passed, 0 failed |
| `pnpm build` | exit 0, built in 1.19s |

No test flaked.

**Round-3 must-fix findings, rechecked on the local backend (the builder's `limits.mjs`, my runs):**

| Finding | State now | My run |
| --- | --- | --- |
| Import failed above about 4,000 records | Closed for short records | 10,000 records: export 5.3 s, import 29.3 s, re-export equal apart from ids. 12,500 records plus 12,500 events (the 25,000-row cap): import 38 s, equal. |
| Over 16 MiB could be neither exported nor deleted | Closed | 31.1 MB export in 4.4 s; delete with the phrase and purge to empty in 18.6 s |
| Purge stuck with thousands of childless parents | Closed | 10,000 parents purged in 32.3 s |
| Failed import leaves no workspace | Closed for a failure the abort survives; see must-fix 2 | Oversized record: staging workspace purged |

The builder's handover reports 306 s for the 10,000-record import; mine took 29 s on the same machine, so its timing margin is wider than stated. My mutation sweep was running during some of these runs.

**Round-3 should-fix findings:** purge guard, byte limits in UTF-8, link-value counting on import, the delete form's phrase wiring, and the rollback gate checking `importingAt` each now have a test that a mutant fails.

**Brief items:**

- **Export and import:** owner-only and unrestricted-owner checks, two-workspace isolation, the write fence and the round trip all go red under mutation. A write through `orgs.rename`, `fields.create`, `objects.create` or `fields.retire` during an export is refused with CONFLICT.
- **Deletion:** confirm writes only the marker; the two-workspace test counts every table with an `orgId`; every purge-order mutant is caught.
- **Legal pages, billing, gate document:** unchanged in behaviour since round 3 apart from the limit sentences; spot mutants still caught. Billing code is untouched this round.
- **Handover:** lists the env vars, including the three new optional ones, and says plainly that nothing charges money.

**Schema and rollback:** the change against `origin/integ/m3b` is additive (optional fields on `orgs` and `events`, a widened `events.actor` union, the `billingEvents` table). `a4f3091` is an ancestor of HEAD, is named in `ops/release/notes.json`, and its schema files are identical to HEAD's. I did not re-run the target's own suite this round.

**Secrets:** a pattern scan of the added lines for Stripe, Resend and AWS key shapes and private-key blocks found none. This is not a full audit.

**Tree:** I edited no tracked files and made no commits; `git status` is clean at `840c3bc`. Scratch copies are restored and match the checkout.

## Mutations

68 mutants, each applied alone in a scratch copy and restored: 65 against the job's four vitest files, 3 against the node tests in a scratch clone. 61 caught, 7 survived.

**Caught (61):**

- **Export (11):** restricted owner allowed; admins allowed; events not filtered by workspace; objects not filtered by workspace; no write fence; fence never lapses; two exports at once; `exportedAt` not recorded; fence left up; no byte cap; bytes counted as characters.
- **Import (22):** no byte cap; no row cap; unknown properties accepted; relations unchecked; unknown field keys accepted; staging step without token; staging step by another user; staging workspace visible; `importAbort` not purging; creation gate ignored (start and upload URL); upload kept; no link rows; cycle fix-up without link rows; cycles never closed; empty titles; event time dropped; events unsorted; actor name lost; ref dropped; planner ignoring link weight; planner not keeping file order.
- **Deletion and purge (15):** name unchecked; any phrase accepted; no export or phrase needed; export of any age counts; purge never scheduled; purge without `deletingAt`; batch unbounded; parents before children; skipping `billingEvents`, `links`, `integrationPages` or `usageBudgets`; org row kept; cursor skipping a table; resume cron doing nothing.
- **Fence (2):** `requireMember` and `requireAgent` ignoring closed workspaces.
- **Billing (3):** live key accepted; signature not verified; live-mode events accepted.
- **UI and legal (5):** phrase not sent as `withoutExport`; delete enabled without export or phrase; delete enabled without the name; draft marker removed; 64 MB sentence removed.
- **Rollback gate and gate document (3):** gate ignoring imports; gate ignoring deletions; export-limit sentence removed.

**Survived (7):**

| Mutation | Meaning |
| --- | --- |
| A failed import never calls `importAbort` | Real gap; see must-fix 2 |
| Import writes no slot projections | Real gap: sorting and filtering on imported records would break unnoticed |
| Publish does not freeze authority | Real gap |
| Publish writes no audit row | Real gap |
| Export file never dropped from storage | Real gap |
| Deletion does not pause integration work | Minor gap |
| Export pages do not check the fence token | Mostly covered: `exportEnd` still checks it |

## What I could not verify

- Hosted Convex: timing, the write-rate limit for the production plan, and action memory at 64 MB.
- An import killed by the action time limit on the local backend. A 48,000-row import finished in 61 s, so I could not make one run out of time; the orphan in must-fix 2 came from a failed abort instead.
- The builder's 62 MB export run; I did not repeat it.
- Simultaneous imports under real OCC.
- Real Stripe test-mode delivery and the Checkout request against Stripe.
- The Settings cards in a browser with a signed-in session.
- A deployed rollback to `a4f3091`, or the gate against a real backup.
- Legal wording, price, live billing and the remaining gate rows stay pending with Shakur.

Files are in `/tmp/verify-I-m10-r4b`:

- verdict.md
- verifier.test.ts (SIM probes)
- svc/ops/workspace/vbig.mjs, svc/ops/workspace/vlimits.mjs (SERVICE probes)
- svc-verifier-big2.log, svc-verifier-cap.log, svc-verifier-timeout.log, svc-verifier-bigimport.log
- svc-builder-roundtrip.log, svc-builder-large.log, svc-builder-parents.log, svc-builder-failure.log
- mutate.mjs, mutate.out, mutations.json, mutations.log
- install.log, typecheck.log, test.log, authority.log, release.log, build.log
