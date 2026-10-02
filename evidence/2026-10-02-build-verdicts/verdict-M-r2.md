VERDICT: PASS

Verifier: Claude Fable 5.1 (claude-fable-5-1). I did not build this job.
Checked: branch `ops/intake-cli` at `fd3b705`, two commits on top of `origin/release/2026-10-03` (`f113ca7`). The job brief names that release as the base, so I diffed against it rather than `origin/build/unified-remold-2026-09-24`. Diff: 4 files, +97 −13, no schema change.

The round-1 must-fix is fixed and tested, the two round-1 surviving mutations are now caught, and every required suite is green on my own run. No must-fix defects remain.

## Must-fix

None.

## Round-1 findings, rechecked

| Round-1 item | Status at `fd3b705` | Evidence |
|---|---|---|
| Must-fix 1: duplicate key hash breaks the live key with a 500 | Fixed | `convex/agents.ts:52` refuses with `CONFLICT "An agent with this key already exists"` before any write. Second CLI insert: nothing written, first key still gets 201. |
| Should-fix 1: no test for the admin check on the non-intake CLI path | Fixed | `convex/intake.test.ts:499`; both round-1 survivors now go red (F and G below). |
| Should-fix 2: handover used `bunx` | Fixed | Handover command now uses `pnpm exec convex run`. |
| Should-fix 3: any `keyHash` string accepted | Fixed | `convex/agents.ts:51` requires `^[0-9a-f]{64}$` and a non-empty `keyPrefix`, else `VALIDATION`. |
| Should-fix 4: `intake: true` without `scoped: true` still creates the key | Not done (the builder says so; it was not in the round-2 instructions) | See should-fix 1 below. |

## Should-fix

1. **`"intake": true` without `"scoped": true` still creates a key with `readObjectIds` set to all 10 objects** (`convex/agents.ts:56`). Carried over from round 1. No leak today: with that key, `GET /api/v1/records?object=person`, `/objects` and `/me` all return 403 and the lead POST returns 201, because of `purpose: "intake"`. The key then rests on that single check. Forcing `scoped` when `intake` is set, or refusing the combination, removes the trap. The handover command does include `"scoped":true`.
2. **Two variants of the duplicate guard are untested.** Narrowing the guard to the same workspace only, or to non-revoked rows only, leaves all 55 tests green (K and L below). Either narrowing would bring back the 500, because the key lookup uses `.unique()` across all workspaces and all states (`convex/identity.ts:27`). Today's behaviour is right: my probes got `CONFLICT` for a duplicate in another workspace and for a duplicate of a revoked key. One extra assertion for each would pin it.
3. **A whitespace-only `keyPrefix` (`" "`) is accepted.** Cosmetic: the prefix is display-only, and the handover recipe always produces 12 characters.

## What I verified and how

Suites, run by me on `fd3b705` (no flakes, no reruns needed):

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | Already up to date |
| `pnpm typecheck` | exit 0 |
| `pnpm test --maxWorkers=2 --testTimeout=15000` | Test Files 48 passed (48), Tests 307 passed (307) |
| `pnpm test:authority` | Test Files 17 passed (17), Tests 101 passed (101) |
| `pnpm verify:release` | tests 37, pass 37, fail 0 |
| `pnpm build` | exit 0, built in 1.18s, only the chunk-size warning |

Brief items:

- **CLI insert with an owner `asUserId` creates a working key.** Test at `convex/intake.test.ts:451`: lead POST 201, records read 403, changes POST 403, all four grants issued by the named owner. Fail-before reproduced by me: with the three source files at `f113ca7`, this test fails with `UNAUTHENTICATED "Sign in first"`.
- **Non-owner refused, nothing written.** Tests at `intake.test.ts:463` and `:471`. My probes: an admin gets `FORBIDDEN "Owner membership required"`; a plain member and an owner of another workspace get `"Admin membership required"`. Agent, grant and audit counts were unchanged in each case.
- **Settings path unchanged.** The signed-in branch still calls `requireMember(ctx, orgId, "owner")` (`convex/lib/intake.ts:49`).
  - The agent row and its four grants from the CLI path match those from `api.agents.createIntake` field by field (ids, timestamps and key material excluded).
  - A signed-in admin is still refused on `createIntake`; an unauthenticated caller gets `UNAUTHENTICATED`.
  - Passing `asUserId` or `intake` to the public `create`, `createScoped` and `createIntake` actions is rejected by argument validation.
- **`agents:insert` stays internal.** `convex/agents.ts:44` is `internalMutation`; the test goes red when it becomes `mutation`.
- **Duplicate hash (round 2).** Refused with `CONFLICT` for: the same CLI call twice, a hash already minted through Settings, a hash held by another workspace, and a hash held by a revoked key. Nothing was written in any case, and a working first key kept returning 201. A revoked key still gets 401, not 500.
- **Hash shape (round 2).** Refused with `VALIDATION`, nothing written: uppercase hex, trailing newline, leading space, empty string, 65 characters, plus the builder's four cases.
- **Round-2 fail-before.** With `convex/agents.ts` at `1930632`, I get "2 failed | 5 passed", the same two tests as the handover.
- **Existing minting paths still pass the new checks.** `create`, `createScoped`, `createIntake`, `createGmailSync` and `createAs` all create keys; an admin can still create a normal scoped key from the CLI path.
- **Read-only workspace.** CLI creation refused with "Workspace is read only", nothing written.
- **Handover command.** I ran the shell recipe: the key matches `rm_[0-9a-f]{40}`, the hash is 64 lowercase hex and equals what Node's SHA-256 gives, the prefix is 12 characters. Placeholders only; no real key in the handover or the diff.
- **Rollback.** No change to `convex/schema.ts`. The new checks only refuse inputs, and the grant rows have the shape the previous release already reads.
- **Secrets and network.** None in the diff. The new tests use convex-test only, with a constant `rm_cccc…` test key.

## Mutations

Each applied in a scratch copy, then `convex/intake.test.ts` and `convex/agents.test.ts` run (55 tests).

| # | Mutation | Result |
|---|---|---|
| A | duplicate-hash check removed | Caught ("refuses a second key with the same hash") |
| B | hash regex removed, prefix check kept | Caught |
| C | prefix check removed, regex kept | Caught |
| D | regex made case-insensitive | Caught |
| E | regex length unbounded / end anchor dropped | Caught (both) |
| F | `memberAs` role check removed (round-1 M3) | Caught ("refuses a plain member creating a normal key") |
| G | `insertAgent` skips `memberAs` on the CLI path (round-1 M9) | Caught (same test) |
| H | `grantIntake` ignores `asUserId` | Caught (3 tests red) |
| I | `memberAs` looks up membership in any org | Caught ("refuses an owner of a different workspace") |
| J | `insert` becomes a public `mutation` | Caught ("stays internal") |
| P | `purpose: "intake"` dropped | Caught (2 tests red) |
| K | duplicate check limited to the same workspace | Survived (should-fix 2) |
| L | duplicate check ignores revoked rows | Survived (should-fix 2) |
| M | duplicate check only when `asUserId` is given | Survived; signed-in paths mint the key server-side, so no behaviour changes in practice |
| N | hash validation only when `asUserId` is given | Survived; same reason |
| O | CLI path asks `memberAs` for "admin" instead of "owner" in `grantIntake` | Survived, behaviour unchanged: `issue()` → `manage()` in `convex/authority/grants.ts` refuses non-owners independently (same as round 1) |

## Not verified

- Nothing was run against a real Convex deployment: no `convex run`, no deploy, no production or hosted calls. Whether `convex run agents:insert` accepts the JSON argument exactly as quoted in the handover is checked only as far as the hash, prefix and argument names.
- Whether the live deployment already holds agents with duplicate key hashes from before this guard. The guard prevents new ones and does not repair old ones; I have no evidence that any exist.
- `proof:authority` and the other service sweeps need a running backend and are outside the required runs; I did not run them.
- No UI was changed, so nothing was checked in a browser.

Scratch: logs are in `/tmp/verify-M-intake-r2/` (`test.txt`, `authority.txt`, `release.txt`, `build.txt`, `mutations.txt`, `probe.txt`, `mutate.mjs`). The mutated copy and my probe test were deleted. The checkout is clean at `fd3b705`; no tracked file was edited and nothing was committed.
