VERDICT: REVISE

Verifier: Claude Fable 5.1 (claude-fable-5-1). I did not build this job.
Checked: branch `ops/intake-cli` at `1930632`, one commit on top of `origin/release/2026-10-03` (`f113ca7`). The job brief names that release as the base, so I diffed against it rather than `origin/build/unified-remold-2026-09-24`. Diff: 4 files, +63 −13, no schema change.

The fix itself does what the brief asked, and every required suite is green. One must-fix: running the documented command twice with the same key hash permanently breaks the live intake key.

## Must-fix

### 1. Re-running the CLI command with the same hash breaks the working key (500), and revoking does not recover it
- **Where:** `convex/agents.ts:53` inserts the agent without checking for an existing `keyHash`; `convex/identity.ts:27` looks the key up with `.unique()` on `by_key_hash`, which throws when two rows match.
- **Input:** `internal.agents.insert` called twice with identical arguments (`intake: true`, same `keyHash`, owner `asUserId`). This is what happens if the operator re-runs the `convex run` line from the handover, for example after a CLI timeout where the first call did commit.
- **Wrong output:**
  - The second insert succeeds: 2 agents, 8 grants.
  - `POST /api/v1/intake/lead` with the key returned 201 before the duplicate and returns `500 {"code":"INTERNAL","message":"Something went wrong"}` after it.
  - After `agents.revoke` on the duplicate it is still 500, because the lookup throws before it reads `revokedAt`.
  - The only recovery is minting a new key and changing the website's env; leads are refused with 500 until then.
- **Why it belongs to this job:** the same collision exists on the base for non-intake `agents:insert` (I reproduced a 500 there too), but every earlier path mints the key server-side. This job makes an operator-supplied hash the documented procedure for the live deployment.
- **Suggested fix:** in `insertAgent`, before the insert, refuse with `fail("CONFLICT", "An agent with this key already exists")` (or the nearest existing code) when `by_key_hash` already has a row for `args.keyHash`. Add a test: second CLI insert with the same hash is refused, nothing is written, and the first key still gets 201.

## Should-fix

1. **No test covers the admin check on the non-intake CLI path that this job refactored.** `adminId` was replaced by `memberAs(..., "admin")`. Two mutations survived the full `pnpm test` (304 passed) and `pnpm test:authority` (101 passed): removing the role check from `memberAs` (`convex/identity.ts:56`), and skipping `memberAs` in `insertAgent` (`convex/agents.ts:48`). My probe shows today's behaviour is correct (a plain member is refused with "Admin membership required" on `agents:insert` and `agents:createAs`, nothing written), but nothing in the required suites would catch a regression. Add that one test.
2. **The handover command uses `bunx convex run`; the repo uses `pnpm exec convex run`** (README.md:30, AGENTS.md "Use pnpm"). Change it before it goes into a runbook.
3. **`agents:insert` accepts any `keyHash` string.** `keyHash: "not-a-hash"` with `keyPrefix: ""` was accepted and creates a dead key plus four live grants. A `^[0-9a-f]{64}$` check alongside the duplicate guard would catch operator slips.
4. **Leaving out `"scoped": true` with `"intake": true` still creates the key**, with `readObjectIds` set to all 10 objects. Reads are still refused with 403 because of `purpose: "intake"`, so there is no leak today, but the key then depends on that one check. Forcing `scoped` when `intake` is set, or refusing the combination, would remove the trap.

## What I verified and how

Suites, run by me on `1930632` (no flakes, no reruns needed):

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | Already up to date |
| `pnpm typecheck` | exit 0 |
| `pnpm test --maxWorkers=2 --testTimeout=15000` | Test Files 48 passed (48), Tests 304 passed (304) |
| `pnpm test:authority` | Test Files 17 passed (17), Tests 101 passed (101) |
| `pnpm verify:release` | tests 37, pass 37, fail 0 |
| `pnpm build` | built OK, only the chunk-size warning |

Brief items:

- **CLI insert with an owner `asUserId` creates a working key.** Test exists (`convex/intake.test.ts:440`): lead POST 201, records read 403, changes POST 403. Fail-before reproduced by me: with the three source files reverted to `f113ca7`, the new tests give "2 failed | 2 passed", both with `UNAUTHENTICATED "Sign in first"`, matching the handover.
- **Non-owner refused, nothing written.** Test exists (`intake.test.ts:452`). Probes: an admin gets `FORBIDDEN "Owner membership required"`; a plain member gets "Admin membership required"; an owner of another workspace is refused. Agent, grant and audit counts were unchanged in each case.
- **Settings path unchanged.** The signed-in branch still calls `requireMember(ctx, orgId, "owner")`. The agent, its four grants and the audit row from the CLI path are identical in shape to those from `api.agents.createIntake` (compared field by field, ids and timestamps excluded). A signed-in admin is still refused, including when passing extra `asUserId`/`intake` arguments to the public `create`, `createScoped` and `createIntake` actions (argument validation rejects them).
- **`agents:insert` stays internal.** `convex/agents.ts:44` is `internalMutation`; the test goes red when it is changed to `mutation`.
- **Handover command.** I ran the shell recipe as written: the key matches `rm_[0-9a-f]{40}`, the hash and prefix match what the server computes, and a key inserted that way gets 201 on the intake route.
- **Cross-workspace.** A CLI key for org A writes only org A records; using org A's owner as `asUserId` for org B is refused; `GET /records`, `/objects` and `/me` with the intake key all return 403.
- **Read-only workspace.** CLI creation is refused with the read-only error, nothing written.
- **Owner later demoted.** The key stops working (403), the same as a Settings-created key.
- **Rollback.** No schema or index change; the grant rows are the same shape the previous release already reads.
- **Secrets and network.** None in the diff; the test key is a constant `rm_cccc…`. The new tests use convex-test only.

## Mutations

Each applied in a scratch copy, then `convex/intake.test.ts` and `convex/agents.test.ts` run.

| # | Mutation | Result |
|---|---|---|
| M2 | `grantIntake` ignores `asUserId` | Caught (2 tests red) |
| M4 | `memberAs` looks up membership in any org | Caught ("refuses an owner of a different workspace") |
| M5 | `insert` becomes a public `mutation` | Caught ("stays internal") |
| M7 | signed-in path falls back to `ownerOf` | Caught ("is created only by the workspace owner") |
| M8 | CLI path issues grants as `ownerOf` instead of the named user | Caught ("refuses an admin who is not the owner") |
| M10 | `purpose: "intake"` dropped | Caught (2 tests red) |
| M1 | CLI path asks `memberAs` for "admin" instead of "owner" | Survived, behaviour unchanged |
| M6 | Settings path asks `requireMember` for "admin" instead of "owner" | Survived, behaviour unchanged |
| M3 | `memberAs` role check removed | Survived, also on the full suite and authority suite (should-fix 1) |
| M9 | `insertAgent` skips `memberAs` on the CLI path | Survived, also on the full suite and authority suite (should-fix 1) |

M1 and M6 survive because `issue()` → `manage()` (`convex/authority/grants.ts:48`) independently refuses non-owners with "Owner required", and the test regex `/owner/i` matches either message. A non-owner is still refused, so the owner check in `grantIntake` is a second layer rather than an untested one.

## Not verified

- Nothing was run against a real Convex deployment: no `convex run`, no deploy, no production or hosted calls. Whether `convex run agents:insert` accepts the JSON argument exactly as quoted in the handover is checked only as far as the hash, prefix and argument names.
- `ops/authority/service-sweeps.mjs` does exercise `agents:createAs` denial, but it needs a running backend (`proof:authority`), which is outside the required runs; I did not run it.
- No UI was changed, so nothing was checked in a browser.

Scratch: logs and probe tests are in `/tmp/verify-M-intake/` (`zzprobe*.test.ts`, `test.txt`, `authority.txt`, `release.txt`, `build.txt`). The mutated copy was deleted. The checkout is clean at `1930632`; no tracked file was edited and nothing was committed.
