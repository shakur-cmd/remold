# Job E: fix the defects Sol found outside campaign email
Branch: `fix/sol-review`. Job id: E. Base: origin/integ/campaigns (aa68030). Read COMMON.md first, then the findings in evidence/2026-10-03-campaigns/E/sol-review.md (your own earlier review).

Fix, each with a failing-first test, in the dense house style:
- F3: delete suggestions must detect edits made since the proposal (compare the reviewed snapshot with current values, including newly added values); stale -> conflicted, fresh -> applied.
- F4 (non-email part): CSV import: validate the complete row, including pending lookup creations, before any write, so a rejected row leaves no records, links or events behind. Remove the false comment. (The email-rule ordering part is being fixed on the campaign branch; do not touch convex/lib/emailRules.ts or convex/campaign*.ts.)
- F10: MCP write tools accept an optional `idempotencyKey` and send it as the Idempotency-Key header; retry with the same key returns the original result (test with a fetch stub and with the REST route).
- F11: date writes must be within a supported range (e.g. years 1000-9999 or what the UI renders); out-of-range fails before storage with VALIDATION; accepted values survive write -> REST projection.
- F12: retired-field values must not block an otherwise authorized agent delete; hidden/protected retained values still block.
- F13: `/me` adds the agent's effective capability grants (projected, no secrets) alongside legacy grants; `/objects` field metadata adds `withTime`, `protectedFromAgents`, and whether the agent can write it directly or only propose. Keep it additive: another job is also adding readable-object scope to `/me`.
- F14: MCP gains a `remold_record_events` tool with cursor/limit paging (REST already has /records/:id/events).
- F16: delete `findByTitle` if it truly has no callers (check tests/ops too); make REST /today reuse the shared daily selection instead of its own assembly, keeping the masked output shape.
Do not change campaign, shape-proposal or agent-access code beyond what a fix strictly needs. Full suites + build must pass. Write evidence/2026-10-03-campaigns/E/handover.md (per COMMON.md) and commit on fix/sol-review. Do not push.
