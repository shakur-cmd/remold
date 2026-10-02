VERDICT: REVISE

I am Astra (gpt-6-astra) via Codex, the independent verifier for E-m5. Checked `m5/social-calendar` at `3d112ef39960adcf2f4920d05b0fd59bc8ea7bbe` against the brief's base, `origin/integ/m3` (`20f561e`). Evidence is SIM/local. No tracked files changed, no commits, deployments, production calls, or real email.

**Must-fix defects**

1. **An explicitly timed post can appear on the wrong day and lose its time when dragged.** `src/lib/calendar.ts:29,38` uses the inherited UTC-midnight heuristic in `src/lib/fields.ts:15,33`. In `America/New_York`, entering `2026-10-05T20:00` produces `2026-10-06T00:00:00.000Z`. The calendar treats that as all-day October 6 instead of October 5 at 8 PM. Dragging it to October 8 returns `2026-10-08T00:00:00.000Z`, rather than the required `2026-10-09T00:00:00.000Z`. Two independent date probes failed; changing only the component fixture from 11:30 PM to 8 PM also failed both month and week placement assertions. This is an inherited helper defect exposed by the new feature, not newly introduced helper logic. Fix: distinguish legacy all-day values from explicit instants without assuming every UTC-midnight timestamp is all-day; preserve legacy data and add these regressions. Evidence: [probes.log](/tmp/verify-E-m5/probes.log), [8pm-component.log](/tmp/verify-E-m5/8pm-component.log).

2. **Retiring the published-link field disables the mandatory rule.** `convex/lib/applyChange.ts:129` excludes retired fields and line 130 only validates when a link field exists. Reproduction through public mutations: retire Post.publishedLink using `fields.retire`, then create `{title: "No link", status: "published"}`. Expected VALIDATION; actual result contains both a record ID and event ID. The handover calls this intentional, but the brief provides no exception. Fix: keep the invariant enforced when the field is retired or missing, and prevent retirement or provide a safe recovery path. Add create/update regression tests. Evidence: [probes.log](/tmp/verify-E-m5/probes.log).

3. **Yesterday's posts can hide every post due today.** `convex/today.ts:31` takes the earliest 50 records across a three-day window before `src/routes/Today.tsx:31` filters to the local day. Reproduction: create 50 unpublished posts around October 4 noon UTC and one at October 5 14:00 UTC; query Today for October 5. The response contains only the 50 yesterday records. In New York, the client filters all of them out and hides the card despite today's post. Fix: filter using the viewer's actual day boundaries before limiting, preserving plain-date semantics, or paginate until today's records are obtained. Evidence: [probes.log](/tmp/verify-E-m5/probes.log).

4. **The generic calendar excludes valid unindexed date fields.** `src/components/Calendar.tsx:26`, `src/routes/ObjectList.tsx:58`, and `convex/records.ts:25` require a slot. Create a custom object and five date fields through public mutations; the fifth is valid but unslotted. Selecting it through `records.inRange` returns VALIDATION: "Calendar needs an indexed date field". It is also absent from the date selector. Retiring the first four leaves an object with an active date field but no calendar switch. This narrows the brief's generic date-field requirement without approval. Fix: support an authority-preserving bounded/paginated fallback for unslotted dates, with regression coverage. Evidence: [probes.log](/tmp/verify-E-m5/probes.log); UI exclusion confirmed by source review.

5. **The tests do not detect completely broken dragging.** Replacing the `onMove(...)` call in `src/components/Calendar.tsx:133` with a no-op left all 139 tests passing. The nine calendar tests check helper arithmetic and static markup, not drag-to-update behavior. The external builder Playwright script is not part of the suite. Fix: add a runnable interaction test that drags a record, verifies the persisted date and preserved local time, and fails with this mutation. Evidence: [mutant-disconnect-full.log](/tmp/verify-E-m5/mutant-disconnect-full.log).

**Should-fix**

No additional independently established defects beyond the required changes above.

**What I verified**

All required commands ran independently in the checkout and exited 0:

| Command | Summary | Evidence |
|---|---|---|
| `pnpm install --frozen-lockfile` | Already up to date; pnpm 11.23.0 | [install.log](/tmp/verify-E-m5/install.log) |
| `pnpm typecheck` | Both TypeScript checks passed | [typecheck.log](/tmp/verify-E-m5/typecheck.log) |
| `pnpm test` | 35 files, 139 tests passed | [test.log](/tmp/verify-E-m5/test.log) |
| `pnpm test:authority` | 17 files, 100 tests passed | [authority.log](/tmp/verify-E-m5/authority.log) |
| `pnpm verify:release` | 19 passed, 0 failed | [release.log](/tmp/verify-E-m5/release.log) |
| `pnpm build` | Built successfully; chunk-size warning | [build.log](/tmp/verify-E-m5/build.log) |

No timeout flaked in this verification, so no timeout rerun was needed.

- Reviewed the complete [job diff](/tmp/verify-E-m5/job.diff), brief, M5 plan section, project rules, and builder handover.
- Existing tests cover the Post fields, additive/idempotent migration, published-link rule, agent grants/proposals, Today inclusion, range boundaries, local month/week placement, and time-preserving helper arithmetic. The important rule tests fail when their enforcement is removed. Drag integration coverage is missing as demonstrated above.
- Two additional adversarial tests passed: calendar queries reject another workspace/another object's field; refused linkless creation leaves both records and events unchanged. The seven independent probes totalled 2 passed and 5 failed, identifying defects 1–4.
- Authority tests passed for record-scoped calendars, hidden values, and hidden date fields. Removing calendar projection exposed secret text and failed the masking test.
- Schema and lockfile are unchanged by E-m5. `convex/schema.ts` also matches named rollback target `63dc87b964abca599133c71bd1301547c0dbba06`. The additive migration test preserves existing metadata and is idempotent. This is not a runtime rollback certification.
- No provider-publishing path exists in the new Post/calendar flow: status writes use `applyChange`; the diff adds no provider SDK, credential, fetch, scheduler, or publishing action. No new secret was found in the reviewed diff. Existing symbolic `social.publish` capability declarations do not dispatch posts.
- Reviewed builder month-desktop and week-phone screenshots as appearance evidence only. They are not independent interaction proof.

**Mutations caught and survived**

Each mutation ran separately in a scratch copy, then its source was restored. Command pattern: `node node_modules/vitest/vitest.mjs run <test files>`; authority masking also used `--config ops/authority/vitest.config.ts`. The scratch copy used the checkout's installed dependencies. `pnpm exec` initially refused that symlinked modules directory, so scratch tests used the installed runner directly.

| Implementation mutation | Result |
|---|---|
| Remove published-link validation | Caught: 1/6 Post tests failed |
| Remove agent Post restrictions | Caught: 1/6 Post tests failed |
| Bucket records by UTC day | Caught: 4/9 calendar tests failed |
| Drop time during date movement | Caught: 2/9 calendar tests failed |
| Remove calendar record projection | Caught: 1/5 masking tests failed |
| Return no Today posts | Caught: 1/6 Post tests failed |
| Disconnect drag-end callback | **Survived: 9/9 calendar tests and 139/139 full-suite tests passed** |

[Mutation summary](/tmp/verify-E-m5/mutations.log). Restoring the implementation returned the Post/calendar tests to **15/15 passing**: [restored.log](/tmp/verify-E-m5/restored.log). These baseline/mutant/restored results provide the before/after comparison. Temporary probe tests and the scratch source copy were removed; logs remain.

**What I could not verify**

I did not start a local backend or rerun the builder's browser harness, so I cannot independently certify persisted browser dragging, touch interactions, or fresh desktop/phone screenshots. Component placement was exercised through server rendering. No hosted behavior, production migration, or runtime rollback was exercised. No fixes were made; acceptance awaits revisions and fresh independent verification.

Saved verdict: `/tmp/verify-E-m5/verdict.md`.