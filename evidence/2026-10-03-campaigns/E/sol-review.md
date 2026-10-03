# Remold review

## Scope and evidence

Reviewed:

| Baseline / branch | Commit |
|---|---|
| `release/2026-10-04` | `cc9ed1c` |
| `campaigns/email` | `1cf77cb` |
| `remold/agent-schema` | `54e0919` |

**Local `main` is stale at `1f79309`.** “Main” below means the live baseline you specified, `release/2026-10-04`.

Read the three requested reports, booking brief, decisions log, branch diffs, REST/MCP implementations, metadata, record writes, permissions, imports, approval flows and campaign sender.

Seven failure checks reproduced against actual source functions loaded and transpiled entirely in memory. Database and identity boundaries used fixtures; MCP used an injected fetch stub. All commands exited 0 with assertions confirming the defects. These are **SIM evidence**, not deployed Convex verification. Other findings below are marked **source-traced**.

No fixes were made. Proposed fixes and final verification remain outstanding.

## MISSING

**The central gap: an agent can change individual records and, on the schema branch, propose individual schema changes. It still cannot deliver a complete, reusable business workspace in one reviewable operation.**

Sizes are relative: S is a bounded addition; M spans backend/API/UI; L introduces a substantial execution or integration subsystem.

| Rank | Missing capability | Why it matters / concrete smallest version | Size | Touches | Cheaper model? | Gates |
|---|---|---|---|---|---|---|
| **1** | **Business blueprints applied as one proposal** | “Make this a repair-shop CRM” should produce objects, fields, relations, pipeline options, saved views and starter task recipes together. The schema branch supports separate proposals and at most 12 starting fields per new object; it cannot express a coordinated multi-object setup with references between newly proposed objects. Start with versioned JSON blueprints and one dry-run diff, not a template marketplace. | M | `shapeSuggestions`, metadata helpers, Suggestions UI, REST/MCP; saved views below | Yes for blueprint data and UI; experienced review for transactional apply and permissions | Admin approval of exact diff. Explicit choice before adding sample records or granting access |
| **2** | **Saved views that agents can define** | Views are part of the workspace’s shape. A recruiter needs “Candidates awaiting feedback”; a contractor needs “Quotes needing follow-up”. `ObjectList.tsx:43` keeps sort/filter/range in component state. Board/calendar have URL choices, but no persistent named view definitions exist. Store object, layout, columns/order, filters, sort, grouping and calendar field. Expose list/propose/update through REST and MCP. | M | `schema.ts`, `ObjectList`, Board, Calendar, agent API/MCP | Yes, once validation and read-scope rules are specified | Owner approval for shared defaults; personal views can be reversible direct edits. No sends or spend |
| **3** | **Bounded bulk record proposals and changes** | Cleaning or migrating 500 records currently means 500 tool calls and, by default, 500 approvals. Add a batch with a fixed target snapshot, preview, per-record conflict checks, bounded chunks, progress and idempotency. Include atomic link add/remove operations so an agent can extend a list without overwriting another writer’s additions. | M | `agentApi`, `applyChange`, suggestions, idempotency, HTTP/MCP, approval UI | Cheaper model for client/UI plumbing; stronger review for authority and partial failure | Explicit bulk approval or scoped direct grant. Deletes require impact preview |
| **4** | **Schema lifecycle beyond addition** | Schema branch: add objects/fields/options and relabel. Missing: retire/restore fields, reorder fields/objects/options, archive custom objects, choose title fields, explain indexing capacity and choose unindexed text. Human field retirement already exists; reordering and restoration do not. Without removal and ordering, every remold accumulates yesterday’s shape. Keep retirement additive; do not erase historical values or casually reuse slots. | M | `fields`, `objects`, metadata, shape proposal kinds, Settings, REST/MCP | Yes for ordering and relabel flows; stronger review for retirement dependencies and slot handling | Admin approves retirement/title changes. Hard deletion or data conversion needs separate approval and recovery evidence |
| **5** | **Agent-defined durable automations** | An outside agent can manually execute work, but cannot install “when a deal is won, create a delivery project and its tasks” or “when this date arrives, put a follow-up in the queue”. Existing crons are developer-defined. Start with record/date triggers, predicates and create/update/task/inbox actions. Add deduplication, loop limits, versioning, run history and pause. External sends remain separately approved. | L | Events, scheduler, rules/run tables, domain commands, approval UI, REST/MCP | No for execution/authority core; yes for recipe definitions and editor | Owner approves activation and scope. Explicit caps and live-action grants for sending, publishing or paid calls |
| **6** | **Finish the REST/MCP contract** | MCP still trails REST. Main lacks MCP multi-filter/range queries, full event paging, operation commands and authority commands. REST itself lacks the app’s combined timeline, last-contact query, invoice summaries/overdue invoices and local-day post listing. `me` also omits effective capability grants. Agents should discover their actual permissions and read the same work context as a person. | S/M | `http.ts`, `agentApi.ts`, shared queries, MCP client/tools | Mostly yes; stronger review for authority endpoints | Ordinary masked reads need no new gate. Management actions retain existing scoped authority |
| **7** | **Agent import staging and duplicate review/merge** | The UI has CSV import; REST/MCP do not. `imports.ts` is an internal operator path. CSV skips duplicates by title and creates missing lookups while parsing. Add upload/stage, mapping preview, stable source IDs, resumable commit and duplicate candidates. A merge must preserve links and history rather than delete one contact and hope cleanup is sufficient. | M/L | CSV/import helpers, staging tables, merge domain command, UI, REST/MCP | Mapping/UI: yes. Merge and atomicity: stronger model/review | Owner approves mappings, merges and batch scope. Never infer consent from import |
| **8** | **A daily work queue with ownership and readiness** | Tasks have due date, done, project, blockedBy and about, but no standard assignee. `dueTasks` checks due/done, not dependency readiness. Inbox already supports read/add/resolve; the missing pieces are assignment, explicit handoff, claimed work and paging beyond fixed limits. Today REST returns only tasks and quiet deals, unlike the richer app. Start with assigned tasks, blocked reasons and links to the relevant timeline. | M | Task metadata, daily queries, inbox, Today, agent API/MCP | Yes for UI and metadata; stronger review for scoped queue visibility | Human chooses responsibility and execution grants. Queue membership must not confer additional authority |
| **9** | **Booking and paid-booking loop** | Planned, not built in either reviewed branch. This completes email → meeting → payment attribution. The brief already covers live-page gates, slot races, DST, payment holds and Stripe truth. Keep that scope; calendar synchronization can follow separately. | L | Booking object/tables, public SPA route, slot logic, campaign tokens/report, Stripe webhook, settings, MCP | No for slot/payment state machine; yes for page/UI and tool plumbing | Owner publishes pages and configures Stripe secret/link. Live payments and confirmation sends need explicit gates |
| **10** | **Mailbox/calendar workflow, beyond dates** | Gmail sync records dates and addresses; it is not a conversation inbox or calendar. Campaign replies become Notes and forwards, not a threaded workflow an agent can answer through a reviewed draft. Add thread identity, draft reply, human send approval and meeting reconciliation. Installing the already-built Gmail date sync is an account task, not new development. | L | Gmail integration, conversation/thread records, timeline, approval queue, calendar binding, REST/MCP | Cheaper model for presentation; stronger review for account binding, consent and send recovery | Owner OAuth/account authorization; explicit recipients/content for sends. Customer execution must use customer accounts |
| **11** | **Customer readiness already held off main** | Production AuthKit remains an owner setup task. Workspace archive/import/deletion and subscription groundwork are reported on `m10/first-customer`, not this baseline. Do not rebuild them as “missing features”; review and integrate the existing branch after its legal/commercial gates. These matter before inviting another business to remold its real data. | M integration; auth setup S | Auth identity migration, M10 branch, release/restore checks | Integration plumbing: yes. Identity/data migration: stronger review | Owner WorkOS/Google setup; legal pages, price and live billing approval |

### App/API parity, without inventing gaps

| Capability | Actual state |
|---|---|
| Record create/update/delete | REST and MCP exist, subject to proposals/grants |
| Lookup and links editing | Already supported through generic record values, including IDs/codes; missing safe link deltas and bulk operations |
| Tasks and notes | Already records an agent can create/update/propose |
| Inbox | REST/MCP read/add/resolve already exist; assignment, paging and richer handoff remain |
| Views and saved filters | App has temporary filters/layouts; persistent saved views are missing for everyone |
| Field retirement | Human mutation/UI exists; agent proposal does not |
| Field/object reordering | Missing for both app and agents |
| Import/export | Human CSV path exists; agent endpoints/tools do not |
| Settings | Human settings exist. Owner-controlled secrets, grants and live-action configuration should remain controlled; agents need readable status and proposals, not blanket settings writes |
| Campaign email | Built on branch, not baseline; fix the approval and masking defects below before integration |
| Shape proposals | Built on branch, not baseline; limited to addObject/addField/addOptions/relabel |

## FIX

Severity: **P1** = security boundary, unintended live action or data loss; **P2** = material correctness/reliability; **P3** = misleading contract or removable duplication.

### F1. Campaign preview bypasses field masks

**P1 · `campaigns/email` · SIM reproduced**

Locations:

- `convex/lib/campaign.ts:216`: returns `record.title` without checking the title/name field.
- `convex/lib/campaign.ts:219`: gets company/name personalization without projecting permissions.
- `convex/lib/campaign.ts:220`: reads subject and body directly.
- `convex/lib/campaign.ts:221`: renders those values into the response.

**Repro:** Give a caller record read access but hide Email subject/body and Person name. Request the email preview. The fixture returned:

```text
subject: SECRET SUBJECT
text: SECRET BODY SECRET NAME
name: SECRET NAME
```

The same helper serves human queries and REST/MCP.

**Fix:** Require permission to read the template fields before rendering. Resolve personalization through masked records and `visibleTitle`; require access to company relations and target titles. Apply the same projection to recipient rows and explicit-person previews.

**Verification:** Hide each contributing field separately and assert neither the field nor its derived rendered value appears.

### F2. Approval is not bound to content, audience or schedule

**P1 · `campaigns/email` · content change SIM reproduced; audience/race source-traced**

Locations:

- `convex/lib/emailRules.ts:8`: material-change list omits schedule and follow-up selection parameters.
- `convex/lib/emailRules.ts:43`: changing live content validates it but does not invalidate approval.
- `convex/campaigns.ts:44`: approval accepts no preview/version hash.
- `convex/lib/campaign.ts:64`: audience comes from current Campaign people.
- `convex/campaignSend.ts:85`: final check does not compare approved payload/audience versions.

**Repro:**

1. Approve an email; its run has `confirmed: true`.
2. Change its subject/body while leaving status approved.
3. Confirmation remains true. The next claim uses the edited content.
4. Alternatively, an agent granted Campaign updates adds a person to an active campaign after approval. The sender can include that person without another audience approval.
5. A draft can also change between the human viewing the preview and clicking Approve.

**Fix:** Approval must bind an immutable version of content, destination settings, schedule and audience snapshot. Pass the preview version into approval. Material edits invalidate approval; final dispatch checks that exact version. Dynamic audiences require an explicitly approved bounded rule.

**Verification:** Edit each material input before approval, after approval and between claim/begin. Require refusal or renewed approval.

### F3. Delete suggestions ignore edits made since proposal

**P1 · main · SIM reproduced**

Location: `convex/suggestions.ts:52`. Conflict detection runs only for updates.

**Repro:** Propose deletion of a record containing “Old data”. A person changes it to “New data”. Apply the original delete suggestion. Result was `applied`; the edited record was removed without conflict.

**Fix:** Compare the deletion’s reviewed snapshot/version against current values before deleting. Include newly added values. Consider changed reference impact too, since deletion clears incoming links.

**Verification:** A stale deletion must become conflicted; a fresh deletion must still succeed.

### F4. Failed CSV rows leave writes behind

**P1 · main and worsened by email branch · main SIM reproduced**

Locations:

- `convex/csv.ts:45`: lookup coercion can create a missing record.
- `convex/csv.ts:98`: coercion runs before the entire row is validated.
- `convex/csv.ts:104`: catches the error and continues the enclosing mutation.
- Email branch `convex/lib/applyChange.ts:173`: email rules run after record/event writes.

**Repro:** Import a Person with `createMissing=true`, columns name/company/number. Supply a new company name followed by an invalid number. Result: `created: 0`, one row error, but **Ghost Company remains**.

On the email branch, a row rejected by post-write `emailRules` can likewise retain writes because the CSV caller catches the exception. A helper throw is not a transaction savepoint.

**Fix:** Validate the complete row before writing, including pending lookup creations and domain rules. Alternatively isolate each row in its own mutation so a failed row rolls back completely. Remove the false comment claiming validation always precedes writes.

**Verification:** Compare records, links, events and email-run rows before/after every rejected row. All must be unchanged.

### F5. Uncertain campaign sends release their budget

**P1 · `campaigns/email` · source-traced**

Locations:

- `convex/lib/campaignText.ts:104`: timeout becomes an ordinary retryable failure.
- `convex/campaignSend.ts:69`: expired leases release the count.
- `convex/campaignSend.ts:100`: retryable failures release the count.

**Repro:** Set cap to one. The provider accepts recipient A, but its response is lost. Finish marks A queued and releases the reservation. Before A reconciles, another run can reserve and send recipient B. The cap no longer bounds accepted sends.

**Fix:** Distinguish definite rejection from `outcomeUnknown`. Keep uncertain exposure reserved until reconciliation using the same provider identity/key. An expired worker is not evidence that nothing was sent.

**Verification:** Use a local provider stub that accepts then drops its response. With cap one, B must remain blocked.

### F6. Campaign retries regenerate the payload under the same key

**P2 · `campaigns/email` · source-traced**

Locations: `convex/campaignSend.ts:48`, `:55`, `:56`, `:59`, `:111`.

**Repro:** Claim an email, lose its response, then change the recipient name, company, sender settings or template before retry. The retry uses the same send ID/idempotency key but newly composed bytes. `begin` also does not bind the already-claimed `mail` to the current approved version.

**Fix:** Persist the immutable dispatch payload/version with the send intent. Retry exactly those bytes. A changed message becomes a separately approved operation, not another attempt of the old one.

**Verification:** Capture attempted request bodies with a local fetch stub; retries must match byte-for-byte.

### F7. Inbound reply forwarding is neither durable nor bounded by the normal gates

**P2 · `campaigns/email` · source-traced**

Locations:

- `convex/campaignSend.ts:147`: deduplication is committed before forwarding.
- `convex/campaignSend.ts:153`: forwarding checks only selected configuration problems.
- `convex/campaignSend.ts:171`: ignores the forwarding outcome.
- `convex/campaignSend.ts:182`: acknowledges the webhook.

**Repro:** Forwarding fails or times out after `replied` records the webhook. The endpoint returns success; replay is skipped by `seen`. The reply Note survives, but owner notification is permanently lost.

Separately, a read-only workspace still produces a forward: `state.problems` is ignored. The handover explicitly says forwards skip daily caps, but that exception is not an owner-approved numeric bound.

**Fix:** Store a durable forwarding intent alongside the inbound event and retry/reconcile it. Route forwarding through an explicit notification policy with destination and volume bounds. Preserve inbound reconciliation even when outbound dispatch is blocked.

**Verification:** Fail the first forwarding attempt, then replay/retry. Exactly one notification should eventually be confirmed; a dispatch hold must prevent outbound mail.

### F8. Shape proposal history leaks newly restricted metadata

**P2 · `remold/agent-schema` · SIM reproduced**

Locations:

- `convex/agentApi.ts:145`: lists own rows without current metadata projection.
- `convex/shapeSuggestions.ts:192`: `agentRow` accepts no principal.
- `convex/shapeSuggestions.ts:33`: reads current object/field labels.
- `convex/shapeSuggestions.ts:193`: returns current result keys.

**Repro:** An agent proposes a relabel while authorized. Its access is later reduced. A person changes the target label to confidential text. Reading the agent’s own proposal history still returns the **new current label**. The fixture returned `NEW SECRET LABEL`.

**Fix:** Pass the current principal into projection. Return a stored description of the agent’s original proposal; expose current labels/result keys only where currently readable. Do not hide an agent’s own authored text unnecessarily.

**Verification:** Reduce object/field access after proposal, change labels, and ensure history reveals no new restricted metadata.

### F9. Applying a shape proposal silently grants read access

**P2 · `remold/agent-schema` · source-traced**

Locations:

- `convex/shapeSuggestions.ts:173`: adds the new object to proposer `readObjectIds`.
- `src/routes/Suggestions.tsx:129`: displays the shape summary.
- `src/routes/Suggestions.tsx:145`: Apply offers no separate access choice.

**Repro:** Approve “Add object Payroll”. Applying it also grants the proposing agent access to future records in that object. The displayed proposal does not disclose that authority change.

**Fix:** Make read access an explicit part of the approval, defaulting to the owner’s chosen policy. Record it through the normal authority workflow with appropriate epoch handling. Shape approval should not implicitly decide access.

**Verification:** Apply the object proposal with access declined; the object exists and the agent cannot read it. Granting access must be separately visible and audited.

### F10. MCP cannot use write idempotency

**P2 · main and both branches · SIM reproduced**

Locations: `packages/mcp/src/client.ts:8`, `:22`; `packages/mcp/src/index.ts:20`.

**Repro:** Make a create call, lose the response after commit, then retry it through MCP. The client sends no `Idempotency-Key`. Two identical calls in the stub confirmed the header was absent.

**Fix:** Expose an optional stable operation key in the tool/client and send it as the header. Reuse it for retries; do not generate a fresh key for every attempt or permanently deduplicate intentional identical creates.

**Verification:** Simulate commit followed by response loss. Retrying the same operation must return the original record/event.

### F11. Date validation permits values the read path cannot render

**P2 · main and inherited branches · SIM reproduced**

Location: `convex/lib/values.ts:22`.

**Repro:** Write a with-time date value of `9007199254740991`. `dateValue` accepts it because it is an integer. `readableValue` then throws `RangeError` while generating ISO text.

**Fix:** Validate finite, supported timestamp bounds as well as the all-day/instant encoding. Keep write validation consistent with the calendar’s supported range.

**Verification:** Accepted values must survive write → REST projection → UI formatting. Out-of-range values must fail before storage.

### F12. Retired field values prevent fully authorized agent deletion

**P2 · main and inherited branches · source-traced**

Locations: `convex/agentApi.ts:28`, `:100`.

**Repro:** Populate a custom field, retire it, then have an agent with full object read/delete authority delete the record. `objectFor` excludes retired fields; the deletion check consequently calls the retained value “restricted” and refuses. A human can delete it.

**Fix:** Include retained field definitions in deletion authorization while continuing to exclude them from editable/discoverable active fields. Preserve hidden-field and protected-field checks.

**Verification:** Retirement alone must not block an otherwise authorized deletion. A genuinely hidden/protected retained value must still block it.

### F13. Agent discovery omits the permission and date information agents need

**P2 · main and inherited branches · source-traced**

Locations: `convex/agentApi.ts:56`, `:57`.

**Repro:** Create a capability-scoped agent. `/me` returns legacy `agent.grants`, not effective capability grants/scopes. `/objects` returns `type: date` without `withTime`, and does not describe protected fields or whether a field can actually be written. MCP describes these as “writable fields”.

An agent cannot reliably discover whether to send a date or timestamp, or which direct/proposed changes are authorized.

**Fix:** Return projected effective permissions, permitted actions and relevant expiry/scope information. Include `withTime` and write restrictions in field metadata. Never expose credentials.

**Verification:** Compare discovery against actual allowed/refused operations for a capability-scoped agent.

### F14. MCP still drops useful REST functionality

**P2 · main/email branch; partially fixed on schema branch · source-traced**

Locations:

- `packages/mcp/src/index.ts:15`: main exposes one string-valued filter only.
- `packages/mcp/src/client.ts:29`: main serializes unknown structured inputs as strings.
- `packages/mcp/src/index.ts:16`: no event-history cursor.
- `convex/http.ts:76`: REST already supports event paging.

**Repro:** Main MCP cannot express an AND filter plus date range, or fetch events beyond the recent record response. Calling its client directly with structured filters/range produces unsuitable query values. The schema branch fixes filters/range; it does not add full event paging.

**Fix:** Carry the schema branch’s serialization/tool work into the integrated result. Add an events tool with cursor/limit. Use nullable typed filters and an explicit REST empty-value representation so “field is empty” works consistently with the app.

**Verification:** Run the same compound/empty filters and paged history through app queries, REST and MCP and compare results.

### F15. Campaign scheduling can starve behind blocked runs

**P2 · `campaigns/email` · source-traced**

Location: `convex/campaignSend.ts:73`.

**Repro:** Create 100 live email runs blocked by paused campaigns or configuration. Create a 101st eligible run. Every tick takes the same first 100; the eligible run is never considered.

**Fix:** Use a bounded rotating cursor/fair scheduling policy or maintain a due/eligible queue. Keep resource bounds; replacing `take(100)` with an unbounded collect is not the fix.

**Verification:** Put eligible work after blocked work beyond the scan bound and prove it progresses.

### F16. Remove one unused matcher and shrink the duplicated daily path

**P3 · main · source inspection**

Locations:

- `convex/lib/find.ts:8`: `findByTitle` has no production callers in `convex`, `src` or `packages`.
- `convex/agentApi.ts:77`: independently assembles Today.
- `convex/today.ts:48`: already provides the shared daily implementation.

**Repro/evidence:** Production caller search found only the `findByTitle` definition. Comparing Today implementations shows the REST path assembles its own reduced result instead of using the app’s shared daily query.

**Fix:** Delete the unused unscoped matcher after checking test/proof dependencies. Reuse shared daily selection logic, with separate masked DTO formatting where necessary. Keep invoice/post additions explicit.

**Verification:** Run title-matching behavior checks and compare task/quiet-deal selection across app and API.

## Review handover

The first integration blockers are **F1, F2, F3, F4 and F5**. They concern masked data, reviewed action scope, deletion and send exposure.

Reproduced before-state evidence:

| Check | Observed failure |
|---|---|
| Campaign masked preview | Secret subject/body/name returned |
| Campaign content edit | `confirmed` remained true |
| Stale delete suggestion | Edited record deleted |
| Failed CSV row | Missing-company record remained |
| Shape history projection | Current confidential label returned |
| Invalid date | Accepted, then projection threw |
| MCP retry support | Idempotency header absent |

**Checker:** this review session. **After-state:** unavailable because no fixes were made. **SERVICE/LIVE checks and fresh verification:** outstanding.
