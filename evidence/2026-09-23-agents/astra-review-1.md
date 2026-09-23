**Astra independent verification: REVISE.** Reviewed commit `3038e586687fb8fec0092af352a195c79ccbef6a` on 2026-09-23 against both frozen specifications.

I made no source edits, commits, fixes, or deployments. The requested build generated its normal output. Network activity was limited to the explicitly requested live probes; all additional reproductions used disposable, in-memory convex-test databases. Git status remained clean. The requested Markdown report is the exception to the repository's usual HTML-report preference. The local decision log was absent.

**1. Required commands, run in order**

| Command | Exit | Result |
|---|---:|---|
| pnpm typecheck | 0 | PASS; no TypeScript diagnostics. Not a test count. |
| pnpm test | 0 | **40 passed, 0 failed; 18 test files passed.** |
| pnpm --filter @remold/mcp test | 0 | **2 passed, 0 failed; 1 test file passed.** |
| pnpm --filter @remold/mcp build | 0 | PASS. |

The MCP tests are separate from the root suite: **42 passing tests in total**. Passing tests do not establish full contract compliance.

**2. Required questions**

**a. FAIL: the HTTP boundary allows replacement of the authenticated identity.**

[convex/http.ts:22](/private/tmp/remold-astra-1/clone/convex/http.ts:22) calls mutations with `{ keyHash, ...args }`. POST bodies become args at lines 32–36, so a body-supplied keyHash replaces the hash derived from the Authorization header. [convex/http.ts:13](/private/tmp/remold-astra-1/clone/convex/http.ts:13) checks the header's syntax; the internal function authenticates whichever hash survives the spread.

Local reproduction: create orgs A and B in **one** test database, create an agent in each, and POST /inbox using A's Bearer key with body `{ text: "probe", keyHash: SHA256(B_KEY) }`. Observed **201**, A inbox count **0**, B inbox count **1**, attributed to B's agent. A fabricated, correctly formatted but unregistered Bearer key plus an active body hash also returned **201**.

This requires knowledge of an active target agent's hash. I did not discover a way to derive another org's hash from an org ID, and I did not attempt this exploit live. The flaw turns stored hashes into usable credentials and breaks binding to the presented key.

No agent API function accepts an orgId. Without hash substitution, same-database attempts to GET or propose an update to B's record with A's key returned **404**; A's company list excluded B.

The complete function trace is:

| Function | Deciding source | Org boundary |
|---|---|---|
| requireAgent | [convex/identity.ts:22](/private/tmp/remold-astra-1/clone/convex/identity.ts:22) | Indexed hash lookup; rejects missing/revoked agents; loads agent.orgId. |
| me | [convex/agentApi.ts:44](/private/tmp/remold-astra-1/clone/convex/agentApi.ts:44) | requireAgent first; counts and identity use principal.org._id. |
| objects | [convex/agentApi.ts:45](/private/tmp/remold-astra-1/clone/convex/agentApi.ts:45) | Objects/fields scoped to principal org. |
| listRecords | [convex/agentApi.ts:47](/private/tmp/remold-astra-1/clone/convex/agentApi.ts:47) | Org-scoped object lookup and shared indexed list helper. |
| getRecord | [convex/agentApi.ts:57](/private/tmp/remold-astra-1/clone/convex/agentApi.ts:57) | recordFor rejects wrong org; events index includes principal org. |
| search | [convex/agentApi.ts:58](/private/tmp/remold-astra-1/clone/convex/agentApi.ts:58) | Search/recent indexes constrain org. |
| related | [convex/agentApi.ts:59](/private/tmp/remold-astra-1/clone/convex/agentApi.ts:59) | Target, relation field and indexed relationships constrain org. |
| today | [convex/agentApi.ts:60](/private/tmp/remold-astra-1/clone/convex/agentApi.ts:60) | Both task and opportunity queries constrain org. |
| propose | [convex/agentApi.ts:70](/private/tmp/remold-astra-1/clone/convex/agentApi.ts:70) | requireAgent, scoped target/values, same-org inbox, principal-org insert. |
| change | [convex/agentApi.ts:71](/private/tmp/remold-astra-1/clone/convex/agentApi.ts:71) | Same scoped resolution, grant check, principal-org applyChange. |
| listSuggestions | [convex/agentApi.ts:73](/private/tmp/remold-astra-1/clone/convex/agentApi.ts:73) | Org/status index. |
| inbox | [convex/agentApi.ts:75](/private/tmp/remold-astra-1/clone/convex/agentApi.ts:75) | Org/status index. |
| inboxAdd | [convex/agentApi.ts:76](/private/tmp/remold-astra-1/clone/convex/agentApi.ts:76) | Inserts into principal org, attributed to principal agent. |
| inboxResolve | [convex/agentApi.ts:77](/private/tmp/remold-astra-1/clone/convex/agentApi.ts:77) | Checks inbox, optional suggestion and optional record orgs before patching. |
| HTTP auth/dispatch | [convex/http.ts:12](/private/tmp/remold-astra-1/clone/convex/http.ts:12), [convex/http.ts:18](/private/tmp/remold-astra-1/clone/convex/http.ts:18) | Hashes header; GET args are constructed explicitly; POST spread permits identity substitution. |

Helpers [convex/agentApi.ts:15](/private/tmp/remold-astra-1/clone/convex/agentApi.ts:15), [convex/agentApi.ts:21](/private/tmp/remold-astra-1/clone/convex/agentApi.ts:21), [convex/agentApi.ts:27](/private/tmp/remold-astra-1/clone/convex/agentApi.ts:27) and [convex/lib/values.ts:13](/private/tmp/remold-astra-1/clone/convex/lib/values.ts:13) enforce object, record and input-reference ownership. Read expansion relies on these stored-reference invariants; it does not independently recheck every related row.

**b. PASS for the authenticated principal's ordinary no-grant path; the boundary bypass in (a) remains a blocker.**

[convex/agentApi.ts:71](/private/tmp/remold-astra-1/clone/convex/agentApi.ts:71) throws before applyChange. Its preceding proposed() helper only reads. My local snapshot of **records, events and suggestions** was byte-identical before and after a denied update (**403**). The live update also returned **403**, with unchanged record, events and pending-suggestion count.

One contract discrepancy: value resolution happens before the grant check, so invalid values can return 400 instead of the specified no-grant 403.

**c. PASS for targeted update fields.**

[convex/suggestions.ts:31](/private/tmp/remold-astra-1/clone/convex/suggestions.ts:31)–40 compares current targeted values with the proposal snapshot, normalizes null/undefined, stores both expected and actual values, and returns before applyChange.

Local evidence: proposal expected city **Original**; person changed it to **Person edit**; apply returned **conflicted** with those two values. Stored suggestion became conflicted. The entire records and events snapshots stayed identical to the post-person-edit baseline. Missing-record handling is at line 33. Existing-record delete proposals do not compare changed fields; that matches the frozen contract's update-only comparison rule.

**d. PASS for repeated application.**

[convex/suggestions.ts:31](/private/tmp/remold-astra-1/clone/convex/suggestions.ts:31) returns already before writes; lines 49–50 apply and resolve within one mutation. Local create-proposal probe: first apply **applied**, second **already**, record delta **+1**, event delta **+1**. The supplied create test checks one record at [convex/suggestions.test.ts:30](/private/tmp/remold-astra-1/clone/convex/suggestions.test.ts:30).

No-op updates intentionally produce zero events ([convex/lib/applyChange.ts:98](/private/tmp/remold-astra-1/clone/convex/lib/applyChange.ts:98)). Concurrent requests were not exercised against the live Convex engine; repeated sequential application was exercised locally.

**e. PASS for intentional client return/storage; UNVERIFIED for hosted logging.**

The plain key is deliberately returned once by creation, as required. [convex/agents.ts:25](/private/tmp/remold-astra-1/clone/convex/agents.ts:25) generates 20 random bytes and hashes the full key. Line 34 stores hash and prefix, not the plain key. [convex/agents.ts:14](/private/tmp/remold-astra-1/clone/convex/agents.ts:14) strips keyHash from list responses; keyPrefix is the only credential material listed, alongside ordinary agent metadata.

I found no explicit key/hash logging in the reviewed paths. A local malformed-body response did not disclose the hash. I could not inspect deployment/platform logs, so “never logged anywhere” is **UNVERIFIED**.

The plain key does enter internal mutation arguments and its return value ([convex/agents.ts:21](/private/tmp/remold-astra-1/clone/convex/agents.ts:21), [convex/agents.ts:29](/private/tmp/remold-astra-1/clone/convex/agents.ts:29)–35), despite the comment saying only the hash reaches the database. This is not evidence that a plain key is stored.

**f. PASS: the tests contain real behavioural assertions. FAIL: their coverage does not fulfill the frozen test contract.**

Two concrete mutations that would make existing tests fail, identified without editing code:

- Remove revoked-key rejection from [convex/identity.ts:24](/private/tmp/remold-astra-1/clone/convex/identity.ts:24): [convex/agents.test.ts:16](/private/tmp/remold-astra-1/clone/convex/agents.test.ts:16) would receive 200 instead of its required 401.
- Reverse inbox ordering at [convex/agentApi.ts:75](/private/tmp/remold-astra-1/clone/convex/agentApi.ts:75): [convex/inbox.test.ts:10](/private/tmp/remold-astra-1/clone/convex/inbox.test.ts:10) would receive Second, First instead of First, Second.

Important blind spots:

- [convex/rest.test.ts:6](/private/tmp/remold-astra-1/clone/convex/rest.test.ts:6) creates separate databases because [convex/test.helpers.ts:5](/private/tmp/remold-astra-1/clone/convex/test.helpers.ts:5) calls makeTest each time. Its other-org record cannot appear in the first database even if org filtering breaks.
- [convex/rest.test.ts:26](/private/tmp/remold-astra-1/clone/convex/rest.test.ts:26) asserts 403 but never compares record/event/suggestion snapshots for that denial.
- [convex/suggestions.test.ts:19](/private/tmp/remold-astra-1/clone/convex/suggestions.test.ts:19) asserts the conflict result but not preservation of the person's record or event count. Code could report a conflict after an unintended write and still satisfy that assertion.
- Repeat-apply tests omit event-count assertions. Cross-org suggestion apply, inbox suggestion linkage and auto-resolution on apply are also absent from these four files.
- The agent-list test checks absence of keyHash, but not the plain key; setGrants is tested only from an empty array, so append-versus-replace is not distinguished.

My additional local probes supplied evidence for several missing assertions, but they do not repair the repository's regression coverage.

**g. PASS for the named UI/backend call shapes. Browser interactions remain UNVERIFIED.**

- Suggestions list uses pending/conflicted/applied ([src/routes/Suggestions.tsx:11](/private/tmp/remold-astra-1/clone/src/routes/Suggestions.tsx:11)).
- forRecord passes orgId/recordId ([src/routes/RecordPage.tsx:304](/private/tmp/remold-astra-1/clone/src/routes/RecordPage.tsx:304)).
- Apply/dismiss pass orgId/suggestionId and handle conflicted/already ([src/components/SuggestionCard.tsx:40](/private/tmp/remold-astra-1/clone/src/components/SuggestionCard.tsx:40), [src/components/SuggestionCard.tsx:93](/private/tmp/remold-astra-1/clone/src/components/SuggestionCard.tsx:93), [src/components/SuggestionCard.tsx:97](/private/tmp/remold-astra-1/clone/src/components/SuggestionCard.tsx:97)).
- Agent creation uses useAction; list/setGrants/revoke use the correct exports and argument names ([src/components/AgentsCard.tsx:21](/private/tmp/remold-astra-1/clone/src/components/AgentsCard.tsx:21), [src/components/AgentsCard.tsx:33](/private/tmp/remold-astra-1/clone/src/components/AgentsCard.tsx:33), [src/components/AgentsCard.tsx:60](/private/tmp/remold-astra-1/clone/src/components/AgentsCard.tsx:60), [src/components/AgentsCard.tsx:64](/private/tmp/remold-astra-1/clone/src/components/AgentsCard.tsx:64)).
- Inbox uses pending, add's text/source, and remove's **id**, matching the backend ([src/components/InboxCard.tsx:14](/private/tmp/remold-astra-1/clone/src/components/InboxCard.tsx:14), [src/components/InboxCard.tsx:21](/private/tmp/remold-astra-1/clone/src/components/InboxCard.tsx:21), [src/components/InboxCard.tsx:44](/private/tmp/remold-astra-1/clone/src/components/InboxCard.tsx:44)).
- Timeline consumes appliedByName, which the backend resolves ([src/routes/RecordPage.tsx:344](/private/tmp/remold-astra-1/clone/src/routes/RecordPage.tsx:344); [convex/events.ts:15](/private/tmp/remold-astra-1/clone/convex/events.ts:15)).
- Today mounts InboxCard ([src/routes/Today.tsx:46](/private/tmp/remold-astra-1/clone/src/routes/Today.tsx:46)); Settings mounts AgentsCard ([src/routes/Settings.tsx:34](/private/tmp/remold-astra-1/clone/src/routes/Settings.tsx:34)); AppShell links to Suggestions and counts pending rows ([src/components/AppShell.tsx:68](/private/tmp/remold-astra-1/clone/src/components/AppShell.tsx:68)).

No wrong status strings or argument names were found in these calls. Typecheck cannot establish command-string usability, UI behaviour, or runtime deployment parity. The root frontend configuration also does not enable strict mode ([tsconfig.app.json:2](/private/tmp/remold-astra-1/clone/tsconfig.app.json:2)), and explicit any casts weaken backend checks.

**h. PASS: owner/member/profile boundaries.**

[convex/orgs.ts:40](/private/tmp/remold-astra-1/clone/convex/orgs.ts:40)–43 rejects removing the last owner; setRole, removeMember and leave all call that guard (lines 49, 56, 61). Management requires admin; only owners may alter owners. A role-member cannot remove or re-role others. Tests exercise member denial, last-owner demotion/leave denial, and removed-member loss of access ([convex/members.test.ts:28](/private/tmp/remold-astra-1/clone/convex/members.test.ts:28), [convex/members.test.ts:38](/private/tmp/remold-astra-1/clone/convex/members.test.ts:38)).

[convex/users.ts:10](/private/tmp/remold-astra-1/clone/convex/users.ts:10)–17 selects the caller by the authenticated tokenIdentifier and patches only that row. Profile input contains no userId/tokenIdentifier override. Clients may describe their own profile, not change another user's record.

**Frozen contract, section by section**

| agents-v1 section | Result | Evidence/deviation |
|---|---|---|
| 1 Files | PASS | Required backend/MCP files and workspace entry exist. |
| 2 Schema | PASS | [convex/schema.ts:14](/private/tmp/remold-astra-1/clone/convex/schema.ts:14), 22–25; extra top-level suggestion.recordId supports the declared index. |
| 3 Identity | FAIL | Internal resolver is scoped, but HTTP keyHash substitution defeats header binding; (a). |
| 4 applyChange | PASS for agent extension | Principal, createdBy and suggestionId wired at [convex/lib/applyChange.ts:61](/private/tmp/remold-astra-1/clone/convex/lib/applyChange.ts:61), 74, 100, 112. Base deletion defect below. |
| 5 Friendly values | FAIL | Date parser accepts invalid dates ([convex/lib/values.ts:36](/private/tmp/remold-astra-1/clone/convex/lib/values.ts:36)). Required fields are not validated when proposing. |
| 6 Suggestions/user API | PASS for specified control flow | [convex/suggestions.ts:15](/private/tmp/remold-astra-1/clone/convex/suggestions.ts:15)–60 and [convex/events.ts:8](/private/tmp/remold-astra-1/clone/convex/events.ts:8)–17; local conflict/idempotency evidence above. |
| 7 Internal agent API | FAIL | Required validation missing at proposal time; ApiSuggestion loses null clears and before values are not fully readable ([convex/agentApi.ts:39](/private/tmp/remold-astra-1/clone/convex/agentApi.ts:39)–40, 62–70). |
| 8 HTTP | FAIL | Authentication hash can be replaced. Normal requested live status/error mappings passed. |
| 9 MCP | PASS for package/build/protocol | Build and tests pass; real stdio tools/list returns all 13 tools. Hosted calls through MCP tools themselves were not exercised. |
| 10 Tests | FAIL for required coverage | Meaningful passing tests, but isolation fixture and missing assertions described in (f). |
| 11 Commands | PASS for requested checks; remainder UNVERIFIED | Tests/typecheck/build ran. Install, codegen and deployment were intentionally not run. |

Additional section-7 reproduction: propose `values: {city: null}` on an existing company. HTTP returned **201** with `suggestion.values: {}`: readableValue returns undefined for null, and JSON serialization drops the field. A date proposal returned `before.dueDate: 1790812800000` versus `values.dueDate: "2026-10-02"`, violating the readable-before shape. These observations were local, not live.

The base contract was also checked:

| backend-v1 section | Result | Evidence/deviation |
|---|---|---|
| 1 Files/disciplines | FAIL for full strictness/index-only claims | Explicit any is widespread; [convex/lib/applyChange.ts:52](/private/tmp/remold-astra-1/clone/convex/lib/applyChange.ts:52) collects an entire object's records to filter unindexed lookup references. |
| 2 Schema | PASS with later extensions | Core tables/indexes remain; agent additions are explicit. |
| 3 Identity | PASS for human boundary | [convex/identity.ts:14](/private/tmp/remold-astra-1/clone/convex/identity.ts:14) and 36; [convex/users.ts:9](/private/tmp/remold-astra-1/clone/convex/users.ts:9). |
| 4 Slots | PASS | Allocation/projection logic [convex/lib/slots.ts:14](/private/tmp/remold-astra-1/clone/convex/lib/slots.ts:14)–28; migration exception at line 35; passing slot tests. |
| 5 applyChange | FAIL | Deleting a linked record leaves dangling canonical links values; reproduction below. |
| 6 Standard objects | FAIL against literal frozen inventory | [convex/lib/standard.ts:10](/private/tmp/remold-astra-1/clone/convex/lib/standard.ts:10)–16 adds address/LinkedIn fields and campaign beyond the six-object inventory. This is contract drift, not a recommendation to delete useful data. |
| 7 Public functions | PASS for reviewed shapes/auth; full exact conformance not certified | Named APIs align; profile/member/search extensions exist. Agent-specific failures and underlying deletion issue are separately identified. |
| 8 Tests | PASS execution; incomplete behavioural proof | In particular, [convex/related.test.ts:15](/private/tmp/remold-astra-1/clone/convex/related.test.ts:15) checks relationship rows, not the surviving record's canonical values. |
| 9 Commands | PASS requested typecheck/test | Codegen not run. |

**3. Three concrete daily-use bugs**

1. **A proposal appears actionable but cannot be applied.** POST /suggestions with `{action:"create", object:"company", values:{city:"Boston"}, reason:"new company"}`. Observed **201 pending**. Apply then fails **VALIDATION: Required field is empty** because name is absent. Required-field clears have the same validation gap. Source: [convex/agentApi.ts:66](/private/tmp/remold-astra-1/clone/convex/agentApi.ts:66)–70 versus [convex/lib/applyChange.ts:89](/private/tmp/remold-astra-1/clone/convex/lib/applyChange.ts:89)–91.

2. **A date typo silently changes the intended deadline.** Propose a task with title and dueDate **2026-02-31**. Observed **201**, with dueDate **2026-03-03**. [convex/lib/values.ts:36](/private/tmp/remold-astra-1/clone/convex/lib/values.ts:36) passes the prefix straight to Date.UTC, which normalizes overflow instead of rejecting it.

3. **Deleting a blocking task leaves a “missing” relationship.** Create task Blocker and task Blocked with blockedBy=[Blocker], then delete Blocker. Observed: relationship rows **1 → 0**, but Blocked's canonical blockedBy still contains the deleted ID; its event count changes by **0**. [src/components/FieldValue.tsx:11](/private/tmp/remold-astra-1/clone/src/components/FieldValue.tsx:11) renders that stale reference as missing, while the readable API filters it out ([convex/lib/values.ts:58](/private/tmp/remold-astra-1/clone/convex/lib/values.ts:58)). Source: [convex/lib/applyChange.ts:69](/private/tmp/remold-astra-1/clone/convex/lib/applyChange.ts:69)–73 deletes relationship rows; clearReferencesTo only handles lookup fields at line 47. This defect is in the shared base path and also affects agent-applied deletes.

All three backend reproductions ran locally. UI consequences above follow directly from the rendering code; no browser session was run.

**Live check: every HTTP status observed**

| # | Request | Status |
|---:|---|---:|
| 1 | GET /me | 200 |
| 2 | GET /objects | 200 |
| 3 | GET /records?object=company | 200 |
| 4 | GET /records/brisk-ember-oyster, baseline | 200 |
| 5 | POST /changes, requested city=X update | 403 |
| 6 | GET /records/brisk-ember-oyster, after denial | 200 |
| 7 | GET /me, after denial | 200 |
| 8 | POST /suggestions, requested probe | 201 |
| 9 | GET /records/brisk-ember-oyster, after proposal | 200 |
| 10 | GET /me, after proposal | 200 |
| 11 | GET /me, malformed key | 401 |
| 12 | GET /me, correctly shaped all-zero “revoked-looking” key | 401 |

Base: https://gallant-pika-581.convex.site/api/v1. /me confirmed org **kh74gfj79fms7mk2x7w3fx56ts8ewy52**, agent **astra-verifier**, role **member**, grants **[]** before the write probes.

| Evidence | Before | After denied change | After suggestion |
|---|---|---|---|
| city | Fabletown | Fabletown | Fabletown |
| updatedAt | 1790099147010 | 1790099147010 | 1790099147010 |
| Returned events | 4 | Same 4, deep-equal | Same 4, deep-equal |
| Entire record/event response | Baseline | Deep-equal | Deep-equal |
| pendingSuggestions | 1 | 1 | 2 |

The one authorized live suggestion remains pending: **kx7eyzy0y9dk81qwgf3myajkm98ez58n**, reason **“Astra live probe; please dismiss”**, proposing city Fabletown → X. I did not apply or dismiss it.

The all-zero key was not known to be an actually revoked key; this proves rejection of an unknown well-formed key. Actual revocation is covered locally by agents.test.ts. Live cross-org isolation and live conflict/idempotency remain untested because the requisite keys/person session were unavailable or outside the authorized probes. No production table dump or deployed-source hash was available.

**MCP live configuration/stdio check: PASS.** Built the package, started dist/index.js with the provided URL/key, completed protocol initialization and tools/list, and closed the process. Server: remold 0.0.0. Returned **13 tools**: remold_me, remold_objects, remold_list_records, remold_get_record, remold_search, remold_related, remold_today, remold_propose_change, remold_apply_change, remold_list_suggestions, remold_inbox, remold_inbox_add, remold_inbox_resolve. tools/list itself makes no CRM request.

Independent checker: **Astra**, this session. Evidence establishes the observed failures and scoped passes; no fixes have been made or verified.

**VERDICT: REVISE**

Blockers:

1. **[convex/http.ts:22](/private/tmp/remold-astra-1/clone/convex/http.ts:22) — request-body keyHash overrides Bearer identity.** Proven cross-org write when the target hash is known, and acceptance of an unregistered header key. Smallest fix: make authenticated keyHash authoritative after the spread, or explicitly allowlist route arguments and reject keyHash in input. Add same-database org and forged-header regressions.
2. **[convex/agentApi.ts:66](/private/tmp/remold-astra-1/clone/convex/agentApi.ts:66) — invalid required-field proposals are persisted.** A missing company name returns 201, then Apply fails. Smallest fix: run shared, read-only canonical/required validation before suggestion insertion, preserving applyChange's validation at application time.
3. **[convex/lib/values.ts:36](/private/tmp/remold-astra-1/clone/convex/lib/values.ts:36) — invalid dates silently normalize.** February 31 becomes March 3. Smallest fix: validate accepted date syntax and actual calendar components before UTC conversion; reject invalid input with fieldKey.
4. **[convex/lib/applyChange.ts:69](/private/tmp/remold-astra-1/clone/convex/lib/applyChange.ts:69) — deleting a link target leaves dangling canonical values.** Surviving records disagree with relationship indexes and REST/UI views. Smallest fix: remove the target ID from each inbound links field through attributed applyChange updates in the same transaction.
5. **[convex/agentApi.ts:39](/private/tmp/remold-astra-1/clone/convex/agentApi.ts:39)–40 — ApiSuggestion loses clear operations and exposes canonical before values.** city:null becomes values:{}, and date before remains epoch milliseconds. Smallest fix: serialize suggestion values/before/conflicts with the same field-aware conversion while preserving explicit null clears.
6. **[convex/rest.test.ts:6](/private/tmp/remold-astra-1/clone/convex/rest.test.ts:6), [convex/suggestions.test.ts:19](/private/tmp/remold-astra-1/clone/convex/suggestions.test.ts:19), [convex/inbox.test.ts:5](/private/tmp/remold-astra-1/clone/convex/inbox.test.ts:5) — mandated safety coverage is missing.** Isolation uses separate databases; denial/conflict/idempotency tests omit critical no-write/event assertions; inbox linkage/application completion is untested. Smallest fix: share one fixture database for org isolation and add the specific state/event/linkage assertions required by frozen section 10.

Optional improvements:

- [src/components/AgentsCard.tsx:76](/private/tmp/remold-astra-1/clone/src/components/AgentsCard.tsx:76): replace the npx package-install instruction with the already-tested local node command from the MCP README, or verify a published distribution. The package is marked private ([packages/mcp/package.json:4](/private/tmp/remold-astra-1/clone/packages/mcp/package.json:4)); registry availability was not checked.
- [convex/agentApi.ts:71](/private/tmp/remold-astra-1/clone/convex/agentApi.ts:71): check the grant after identifying the object but before resolving values, matching the specified 403 precedence.
- [convex/agentApi.ts:44](/private/tmp/remold-astra-1/clone/convex/agentApi.ts:44) and [convex/suggestions.ts:23](/private/tmp/remold-astra-1/clone/convex/suggestions.ts:23): bound/count large queues without collecting all rows; review the unindexed deletion scan at [convex/lib/applyChange.ts:52](/private/tmp/remold-astra-1/clone/convex/lib/applyChange.ts:52) before scale testing.
- [tsconfig.app.json:2](/private/tmp/remold-astra-1/clone/tsconfig.app.json:2): enable frontend strict mode and replace explicit any at HTTP/agent boundaries so passing typecheck provides stronger evidence.
- [convex/lib/standard.ts:16](/private/tmp/remold-astra-1/clone/convex/lib/standard.ts:16): reconcile the frozen base inventory with the shipped campaign/profile extensions instead of leaving the contract stale.
- [convex/agents.ts:21](/private/tmp/remold-astra-1/clone/convex/agents.ts:21): keep the plain key in the action, pass only hash/prefix to the internal mutation, and correct the misleading comment.

