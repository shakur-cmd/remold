# Job E handover

**Awaiting independent verification and local commit.** Builder: Codex (this session). No independent checker has reviewed the fixes. All evidence is **SIM/SANDBOX**, not SERVICE or LIVE. No push, deployment or hosted-service calls were made.

- Branch: `fix/sol-review`.
- Base and current HEAD: `aa680301b8eac33d86d94563d95eb90ae9bad9a9`.
- **Final commit hash: unavailable.** The sandbox rejected `git add` and `git commit` because it could not create `/Users/urkel/Documents/CodeMyVibe/Projects/remold/.git/worktrees/job-E/index.lock` (`Operation not permitted`). Nothing was staged or committed. Approval policy is `never`, so this session cannot obtain permission to complete that step.
- Requested handover format: Markdown, following the explicit Job E instruction.

## What changed

| File | Change |
|---|---|
| `convex/suggestions.ts` | Delete proposals compare the union of reviewed and current value keys; stale deletes conflict; returned conflicts use current field masks. |
| `convex/csv.ts` | Each CSV row executes in a nested internal mutation. A thrown row error rolls back all its lookup, record, link and event writes. Batch authority/column checks still reject before processing. Removed the false pre-write validation comment and the redundant batch-local duplicate set. |
| `convex/lib/values.ts` | Numeric and string date inputs are bounded to UTC years 1000 through 9999, retaining the midnight instant encoding. |
| `convex/agentApi.ts` | Delete authorization includes retained definitions; discovery adds projected live capabilities, date/protection metadata and create/update write modes; Today uses `daily`; proposal/inbox/shape/reply writes reuse existing idempotency storage. |
| `convex/http.ts` | Supplies validated, route/body-bound idempotency headers to the added write handlers. |
| `convex/lib/find.ts` | Removed unused `findByTitle`; retained the permission-aware matcher. |
| `ops/authority/inventory.json` | Declares the new internal CSV row mutation and its proof. |
| `packages/mcp/src/client.ts` | Extracts optional `idempotencyKey` into the header, omits it from JSON, and adds paged record events. |
| `packages/mcp/src/index.ts` | Adds optional stable keys to all write tools, `remold_record_events`, and accurate readable-field copy. |
| `convex/jobE.test.ts` | Sixteen behavior regressions exercise actual Convex functions/REST with an injected local MCP fetch adapter. |
| `packages/mcp/src/client.test.ts` | Two failing-first client contract regressions for write headers and event paging. |
| This evidence directory | Before/after logs, suite logs, original supplied brief/review and this handover. |

## Decisions and compatibility

1. F4 uses the review's explicit alternative: isolate every row in a nested mutation instead of inventing a second domain-validation implementation. The inner function throws; the outer function catches only after that row's writes roll back. This also covers late failures without changing campaign or email-rule files.
2. Batch authorization remains outside the per-row catch. An initial authority-suite run caught the changed batch rejection contract; the shared `importTarget` check restored it without weakening the test.
3. F3 compares field values, including added/removed keys, rather than timestamps. Fresh deletions still apply. Reference-impact snapshots were considered but not added: the requested reviewed snapshot contains record values only. Changes to incoming references alone are not detected by this fix.
4. Stale-delete conflict responses are masked again for the approving member. A failing-first probe showed the raw conflict could otherwise expose a value newly hidden from that member.
5. F10 keeps the existing 24-hour, per-agent, route/body-bound idempotency mechanism. Record writes return the original stored result through current masks. Proposal/inbox/shape replay stores an ID and projects the original entity through the existing read path; if it subsequently changes, the replay shows its current projected state, rather than an old unrestricted DTO. Reply replay stores the bounded reply receipt. A key used with a different request continues to fail with `IDEMPOTENCY_MISMATCH`.
6. Shape and campaign changes are limited to API idempotency wrappers needed for the MCP write contract. No `convex/campaign*.ts`, `convex/lib/emailRules.ts`, shape-application or agent-access implementation was changed.
7. F11 uses the brief's suggested 1000–9999 range. These values survive REST projection; the existing calendar range-query window remains 1970–2200. This change does not expand that calendar-query window or sanitize old invalid stored values.
8. F12 includes retired definitions only when targeting deletes. Retired fields remain absent from discovery and editable fields; actual hidden/protected retained values still refuse deletion.
9. F13 `agent.capabilities` projects only id, capability, scope, mode, delegate and expiry from valid live grants, alongside legacy `grants`. Field `write.create`/`write.update` are `direct`, `propose` or `none`. They describe potential field authority: callers must combine them with the record scopes in `/me`, required fields and lifecycle guards. Named-record direct grants are included. No readable-object scope changes were made, so Job D can add those separately.
10. F16 keeps the REST `{ tasks, quiet }` masked DTO while reusing the app's shared selection. Repository-wide `findByTitle` caller search (including tests and ops, excluding historical documentation/evidence) found only its definition before removal. Existing CSV/title-matching tests continue to pass.
11. No schema, seed, standard-object, env-var, lockfile or dependency changes. No destructive migration. The previous release can read the records written by these fixes because canonical data shapes are unchanged; rolling back restores the old defects and disables the newly added API/MCP functionality. New idempotency marker variants are in the existing `result: any` field and are bound to distinct routes. No deployment or rollback drill was performed.
12. The shared decisions log was searched at task start. It is outside this session's writable roots; these decisions are recorded here for the coordinator to append to the cross-session log.

## Failing-first evidence, side by side

Before: actual base code at `aa68030`, except the additional replay and mask probes, which ran on intermediate fixes before those behaviors were implemented. After: final working-tree code. Full assertion traces are in the linked logs. Some CSV test titles were renamed to make the authority inventory refer to a literal title prefix; assertions were unchanged.

| Finding / check | Before | After |
|---|---|---|
| F3: `delete proposal changed snapshot is checked` | `FAIL`; received `applied`, expected `conflicted` ([before.log](before.log)). | `✓ delete proposal changed snapshot is checked` ([after.log](after.log)). |
| F3: `delete proposal added snapshot is checked` | `FAIL`; received `applied`, expected `conflicted` ([before.log](before.log)). | `✓ delete proposal added snapshot is checked` ([after.log](after.log)). |
| F3: fresh deletion | Existing behavior passed before; preserved as a control. | `✓ delete proposal fresh snapshot is checked` ([after.log](after.log)). |
| F4: rejected CSV number/required rows | Both `FAIL`; record/event snapshots gained ghost-company writes ([before.log](before.log)). | `✓ rejected CSV row leaves no writes: number`; `✓ rejected CSV row leaves no writes: required` ([after.log](after.log)). |
| F4: invalid lookup | Already refused without writes before; preserved as a control. | `✓ rejected CSV row leaves no writes: lookup` ([after.log](after.log)). |
| F10: stable write header | `FAIL`; header was `null`, expected `stable` ([mcp-before.log](mcp-before.log)). | MCP suite `Tests 8 passed (8)` ([mcp-after.log](mcp-after.log)). |
| F10: response loss and REST retry | `FAIL`; baseline forwarded the key as an invalid body field ([before.log](before.log)). | `✓ MCP retry after response loss returns the original REST write and pages events`; one record/event, exact original retry result ([after.log](after.log)). |
| F10: proposals/inbox/shape writes | `FAIL`; retry returned a second suggestion ID ([replay-before.log](replay-before.log)). | `✓ REST write keys deduplicate proposals and inbox writes`; asserts one suggestion, inbox item and shape proposal, plus repeated inbox resolve ([after.log](after.log)). |
| F11: date bounds and projection | `FAIL`; out-of-range write returned no `VALIDATION` error ([before.log](before.log)). | `✓ date bounds reject before storage and accepted dates survive REST projection`; also exercises the human write path ([after.log](after.log)). |
| F12: retired ordinary/protected values | `FAIL`; ordinary retained values refused deletion; protected retained values returned validation instead of the protected-field refusal ([before.log](before.log)). | `✓ retired none values preserve delete authority`; `✓ retired protected values preserve delete authority` ([after.log](after.log)). |
| F12: hidden retained value | Refused before; preserved as a control. | `✓ retired hidden values preserve delete authority` ([after.log](after.log)). |
| F13: live grants and metadata | `FAIL`; `agent.capabilities` absent ([before.log](before.log)). | `✓ discovery projects live capabilities and field write modes`; asserts expiry/scope, actual allowed create and absence after revocation ([after.log](after.log)). |
| F13: named-record update grant | `FAIL`; metadata reported `propose`, expected `direct` ([masks-before.log](masks-before.log)). | `✓ discovery describes direct update fields limited to named records`; actual scoped update succeeds ([after.log](after.log)). |
| F14: MCP event cursor | `FAIL`; `client.recordEvents is not a function` ([mcp-before.log](mcp-before.log)). | MCP suite `Tests 8 passed (8)`; REST-backed regression reads both pages ([mcp-after.log](mcp-after.log), [after.log](after.log)). |
| F16: Today parity after retiring Done | `FAIL`; API selected the completed task, app selected none ([before.log](before.log)). | `✓ REST Today uses the app selection for retained done values` ([after.log](after.log)). |
| F3: hidden conflict value | `FAIL`; conflict response contained `SECRET CITY` ([masks-before.log](masks-before.log)). | `✓ stale delete conflicts do not reveal newly hidden values` ([after.log](after.log)). |

Initial corrected baseline regression run: `Tests 10 failed | 3 passed (13)`, exit 1. MCP baseline: `Tests 2 failed | 6 passed (8)`, exit 1. Additional replay probe: `Tests 1 failed | 13 passed (14)`, exit 1. Additional mask/scope probes: `Tests 2 failed | 14 passed (16)`, exit 1. Final targeted run: `Tests 22 passed (22)`, exit 0 (16 Job E regressions plus six existing CSV tests).

## Requested suite results

| Command | Exit | Final summary / evidence |
|---|---:|---|
| `pnpm test` | 1 | `Tests 1 failed \| 413 passed (414)`; `Errors 1 error`. Only failure: `does not follow a redirect away from the configured sink`, `listen EPERM: operation not permitted 127.0.0.1`, followed by timeout. This unchanged pre-existing test cannot run inside this sandbox. [test.log](test.log) |
| `pnpm typecheck` | 0 | `tsc -b && tsc --noEmit -p convex`, no diagnostics. [typecheck.log](typecheck.log) |
| `pnpm test:authority` | 0 | `Test Files 17 passed (17)`; `Tests 101 passed (101)`. [authority.log](authority.log) |
| `pnpm verify:release` | 0 | `tests 37`; `pass 37`; `fail 0`. [release.log](release.log) |
| `pnpm build` | 0 | Vite production build succeeded; existing large-chunk advisory. [build.log](build.log) |
| `pnpm --dir packages/mcp test` | 0 | `Test Files 1 passed (1)`; `Tests 8 passed (8)`. [mcp-after.log](mcp-after.log) |

Additional sandbox-compatible run:

`pnpm exec vitest run --testNamePattern='^(?!.*does not follow a redirect away from the configured sink)'`

Exit 0: `Test Files 52 passed (52)`; `Tests 413 passed | 1 skipped (414)`. [test-sandbox.log](test-sandbox.log). This exclusion was supplied only on the command line; the test file and test configuration were not changed. It does **not** count as a full-suite pass.

Additional MCP compile: `pnpm --dir packages/mcp build`, exit 0, `tsc` without diagnostics ([mcp-build.log](mcp-build.log)). `git diff --check` passed. The redirect test has no diff against the base.

## Remaining work and owner/coordinator steps

- Restore write access to the shared Git worktree metadata, then stage and commit this Job E diff and evidence on `fix/sol-review`. End the commit message with exactly:

  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`

- Independently compare the supplied before/after logs and rerun the regressions. Final verification is not the builder's certification.
- Rerun the exact full `pnpm test` in an environment allowed to bind loopback. The blocked redirect test must pass before claiming all suites green.
- No new owner account setup or env vars. Use the normal release/approval process for integration and deployment, and rebuild the MCP package with the matching backend. Nothing has been pushed or deployed.
- No new UI screen was built. No browser/backend SERVICE proof or screenshot was captured; the changed API behavior was exercised in convex-test with local adapters.
- Coordinator should copy the decisions above into the shared decisions log when it is writable.
