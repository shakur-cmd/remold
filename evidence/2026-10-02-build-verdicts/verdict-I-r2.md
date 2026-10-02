VERDICT: REVISE

I am Claude Fable 5.1 (claude-fable-5-1), independently verifying I-m10 round 2 at `7bc1e5931978c81ad4bb2d6005da037e09d92d5c` on `m10/first-customer`. I did not build it. Evidence level: **SIM only** (local convex-test, vitest, node).

All five suites pass and all nine round-1 must-fix findings are closed. Two new defects in deletion and export block a PASS. Nothing in the branch charges money, publishes or emails.

## Must-fix

### 1. Deletion leaves rows behind when a workspace has more than 100 integration parents

- **Where:** `convex/workspace.ts:201-205` (`under`) and the purge order at `:207-216`.
- **Cause:** `under()` looks for child rows under only the first 100 parents. If none of those has children, the step is skipped. The parent step then deletes up to 200 parents, including ones whose children were never looked at. The org row is deleted last, so the leftovers can no longer be found by workspace.
- **Input:** one workspace with 150 `safetyTargets`, 150 `integrationCursors` and 150 `integrationBindings`, where only the last 10 of each have children. Export, `confirmDelete`, drain the scheduler.
- **Wrong output:** the workspace is gone, but these rows remain: `{"integrationCallbacks":10,"integrationLookups":10,"integrationObservations":10,"integrationPages":10,"integrationReceipts":10}`. Expected `{}`.
- **Reach:** the integration adapters are gated off in production today (`REMOLD_PAYMENT_CALLBACKS`), so no live workspace has these rows yet. The brief still requires every row to go, and the leftovers include financial receipts.
- **Why the existing test misses it:** the deletion fixture seeds one row per table.
- **Suggested fix:** make each parent step delete its own children first, or have `under` page through all parents, so a parent is never deleted while children exist. Add a test with more than 100 parents and children only on the late ones.

### 2. A workspace with about 2,000 contacts can neither be exported nor deleted, and the legal pages say it can "at any time"

- **Where:** `convex/workspace.ts:20` (`MAX_ROWS = 4000`), `:46`, and `:189` (`confirmDelete` calls `snapshot`).
- **Cause:** the limit counts objects, fields, records, events and link values together. A fresh workspace already uses 51 rows (8 objects, 43 fields), and every record carries at least one create event. Deletion requires the current export's sha256, so it inherits the same limit.
- **Input:** a fresh workspace plus 2,000 people created through `applyChange` (2,000 records and 2,000 events).
- **Wrong output:** `exportAll` and `confirmDelete` both return "This workspace is larger than one file can hold (4000 rows or 4 MB). Ask shakur@codemyvibe.com for a staged export."
- **Conflict with the brief:** item 2 asks for deletion in bounded batches precisely so size does not matter. The purge worker handles any size, but the confirm step in front of it does not.
- **Conflict with the legal text:** `src/routes/Legal.tsx:20` and `:36` say an owner can export and delete "at any time". That is untrue above the limit, and the brief asks for honest text.
- **Scope note:** the coordinator's ruling approved a size limit, but not this value; the builder chose 4000 and did not check it against hosted Convex limits.
- **Suggested fix, either of:**
  - Raise the limit to what one Convex query can really read, verified against a throwaway deployment, and let deletion proceed above it with an explicit "I accept there is no export" confirmation.
  - Keep the limit, say so on both legal pages and in the gate document, and give large workspaces a staged path for export and deletion.
- Either way, add a test with a realistic workspace of a few thousand records.

## Should-fix

- **Any completed Checkout session naming a workspace sets it active.** `convex/billing.ts:55-58` does not check `mode`, `payment_status` or the price. A signed `checkout.session.completed` with `mode:"payment"`, `payment_status:"unpaid"` and `client_reference_id:<orgId>` returned 200 and set the status to `active`. On a shared Stripe account, a buyer can set `client_reference_id` in a payment-link URL. This is harmless while the flag is not enforced; fix it before enforcement or live billing.
- **Import does not count link values toward the row limit.** `convex/workspace.ts:81` counts only objects, fields, records and events, while export also counts link values (`:45-46`). A file with one record holding 20,000 link values imported and wrote 20,000 `links` rows. On hosted Convex this would more likely hit the transaction write limit and fail as a whole, but the refusal should be the clean one.
- **The rollback deletion gate passes silently when it cannot read the backup.** `ops/deploy/prod.mjs:56-57` treats a failed `unzip` as "no deletions". `deletionGate(root, target, '/tmp/…/no-such.zip')` returned without error. The later restore drill would still stop a deploy on a bad zip, so this is not exploitable today; the gate should refuse on its own.
- **Deleting a workspace does not cancel its Stripe subscription.** After deletion `billing.apply` ignores the org, and nothing calls Stripe. This is fine in test mode; before live billing, a deleted workspace would keep being charged.
- **Test gaps (surviving mutants):**
  - Import not writing `links` rows passes all tests; the round trip compares only exports, which read `values`.
  - Removing `<BillingCard>` and `<DataCard>` from `src/routes/Settings.tsx` passes all tests.
  - Removing the `deletingAt` check in `currentPrincipal` or in `billing.apply` passes all tests. The first is covered in practice by `requireMember` and `writable`.
- **A failed purge step is never retried.** Each `purge` run schedules the next; if one throws, the chain stops and the workspace stays half deleted and unreachable.
- **User rows stay after deletion.** `users` rows (name, email) are kept by design. The privacy page says deletion "removes the workspace's data", which should mention the sign-in identity.
- **Timeline cost.** `convex/events.ts:50-58` rescans a record's events from the newest on every page. It is correct in my probes, but the cost grows with history length.
- **Handover format.** The handover is Markdown; AGENTS.md asks for single-file HTML.

## What I verified and how

I read `VERIFY.md`, the job brief, `AGENTS.md`, the handover (both rounds), `verdict-r1.md`, the round-2 ruling and the evidence files. I reviewed the diff against `origin/build/unified-remold-2026-09-24` and the M10-only diff against `d1909e5`.

| Command | My result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Already up to date (pnpm 11.23.0) |
| `pnpm typecheck` | exit 0 |
| `pnpm test --maxWorkers=2 --testTimeout=15000` | 39 files, 180 passed |
| `pnpm test:authority --maxWorkers=2 --testTimeout=15000` | 17 files, 99 passed |
| `pnpm verify:release` | 40 passed, 0 failed |
| `pnpm build` | exit 0, built in 1.22s |

No test flaked. Logs are in `/tmp/verify-I-m10-r2/` (`test.log`, `authority.log`, `release.log`, `build.log`, `probes.log`, `mutations.log`, `mutations.json`).

**Round-1 findings, rechecked:**

| # | Finding | State now |
| --- | --- | --- |
| 1 | Imported history leaked another workspace's agent | Closed. Import stores `{kind:"imported", name}`; `describe` names an agent only in its own workspace. Mutant caught. |
| 2 | Import not atomic or exclusive, dropped unknown fields | Closed. One mutation, whole-document validation; unknown properties, duplicates and bad relations refused with nothing written. Mutants caught. |
| 3 | Import bypassed read-only | Closed. Mutant caught. |
| 4 | Export not one snapshot | Closed. One query. |
| 5 | Deletion began before the owner held the export | Closed. `confirmDelete` needs the name and the current export's sha256. |
| 6 | Unbounded writes at deletion setup | Closed. Confirm writes only `deletingAt`; every later step removes at most 200 rows. |
| 7 | Billing replay and missing audit | Closed. `billingEvents` dedupes by event id and records from/to. Mutants caught. |
| 8 | Rollback target cannot finish deletions | Closed with the gate in `prod.mjs`, subject to the fail-open note above. |
| 9 | Tests that could not fail | Closed for the three named cases; all three mutants are now caught. |

**Brief items:**

- **Export and import:** round trip equal modulo ids, two-workspace isolation and owner-only checks all have tests that go red under mutation.
- **Deletion:** the two-workspace test counts every table with an `orgId` and leaves the other workspace identical. My own probe confirmed that after confirm, nine different calls into the workspace (update, export, import, confirm again, rename, invite, search, timeline, billing status) are all refused and nothing remains after the purge.
- **Legal pages:** `/terms` and `/privacy` start with "Draft, not yet reviewed.", name the contact, and are linked from sign-in.
- **Billing:** off unless `REMOLD_BILLING=test`; `sk_live_` and `rk_live_` refused; live-mode events refused; price from `REMOLD_PRICE_ID`; real HMAC verification in tests with `fetch` stubbed. No real network path is reachable in tests.
- **Gate document and handover:** the gate document exists and its rows are checked by `ops/release/gate.test.mjs`. The handover lists the env vars and says plainly that nothing charges money.

**Schema and rollback:** changes against `4005bb1` are additive (optional `orgs.billing`, `orgs.deletingAt`, `events.at`, a widened `events.actor` union, new `billingEvents` table). `convex/schema.ts` at `a315d89` is identical to HEAD, `a315d89` is an ancestor, and `ops/release/notes.json` names it. The target's history code returns no name for imported actors and does not crash on them.

**Secrets:** a pattern scan of `convex`, `src`, `ops`, `docs` and `packages` for Stripe and Resend key shapes found none. This is not a full secret audit.

I edited no tracked files and made no commits; `git status` is clean. My probe test was deleted from the scratch copy after running.

## Mutations

51 mutants, each applied alone and restored: 47 against the job's four vitest files in a scratch copy (`/tmp/verify-I-m10-r2/mut`), 4 against the node tests in a scratch clone (`/tmp/verify-I-m10-r2/clone`).

**Caught (47):**

- **Export (5):** events not filtered by workspace; owner check dropped; restricted owner allowed; row limit removed; wrong sha256.
- **Import (7):** read-only not checked; non-empty workspace accepted; member masks ignored; lookup ids not remapped; relation target not validated; unknown properties accepted; original event time dropped.
- **Deletion (7):** sha256 not checked; name not checked; purge never scheduled; purge skips `links`; purge skips `integrationLookups`; org row kept; purge with no workspace filter.
- **Fence (7):** `requireMember`, `requireAgent`, `writable`, `principalFor`, `orgs.mine`, `invites.get` and reminder `compose` each ignoring `deletingAt`.
- **History (2):** foreign agent named; timeline sorted by import time.
- **Billing (10):** live keys accepted; on without `REMOLD_BILLING=test`; signature not verified; no timestamp tolerance; live-mode events accepted; checkout open to any member; price hardcoded; no dedupe; stale events apply; event applied to the wrong workspace.
- **Legal and Settings (5):** draft marker removed; contact removed; sign-in footer links removed; status label fixed to "No subscription"; delete enabled without a sha256.
- **Rollback gate (2):** gate call removed; gate ignoring `deletingAt`.
- **Gate document (2):** a Shakur row marked done without approval; a pending row marked done.
  - The second was caught only because the self-test's replacement string stopped matching. A done row that cites any existing test title passes, which is a limit of the check.

**Survived (4):**

| Mutation | Meaning |
| --- | --- |
| Import writes no `links` rows | Real test gap |
| Settings page does not mount the two cards | Real test gap |
| `currentPrincipal` ignores `deletingAt` | Covered by other fences |
| `billing.apply` applies events to a workspace being deleted | Minor gap |

## What I could not verify

- Hosted Convex behaviour: read and write limits per transaction at the 4000-row / 4 MB limit, scheduler behaviour, and OCC for simultaneous imports (convex-test runs them serially).
- Real Stripe test-mode delivery, retries, and the Checkout request against Stripe.
- The Settings cards in a browser with a signed-in session.
- A deployed rollback to `a315d89`, or the gate against a real backup.
- Anything SERVICE, SANDBOX or LIVE. Legal wording, price, live billing and the remaining gate rows stay pending with Shakur.

The verdict is also written to `/tmp/verify-I-m10-r2/verdict.md`.
