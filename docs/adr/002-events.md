# Events and applyChange: proposed contract

This is the production contract for Step 2, not implemented by the throwaway benchmark. Production metadata, records, relations, suggestions and automation writes must use the same transaction boundary. Identity and org bootstrap need their own authenticated bootstrap path before membership exists, with attributable events once the org is created.

```ts
type Actor = {
  kind: "user" | "agent" | "automation";
  id: string;
};
type Event = {
  orgId: Id<"orgs">;
  actor: Actor;               // derived from server-verified authority
  action: "create" | "update" | "delete";
  objectKey: string;
  recordId: string;           // survives deletion as an audit reference
  before: Record<string, FieldValue> | null;
  after: Record<string, FieldValue> | null;
  reason?: string;
  proposedBy?: Actor;         // applying user remains the effective actor
  suggestionId?: Id<"suggestions">;
  requestId: string;          // org-scoped idempotency key, bound to payload
  causedByEventId?: Id<"events">;
  depth: number;             // 0 for a human/agent origin; max 5 for chains
};

async function applyChange(
  ctx: MutationCtx,
  authority: VerifiedAuthority, // constructed server-side only
  change: ValidatedChange,
): Promise<{ recordId: string; eventId: Id<"events">; replayed: boolean }>;
```

`FieldValue` is narrowed by the field metadata. Neither the client nor agent can choose their actor, org membership, grant or automation depth. `ValidatedChange` includes the org, object, operation, values and request ID, and an optional expected-before snapshot. Its name does not bypass validation inside the helper.

Within one Convex transaction: verify membership and operation grant; resolve object and fields in the same org; validate values and cross-org relation targets; compare the expected-before snapshot when applying suggestions; check request replay and payload equality; update record and index rows; append the event. A failed check writes neither record nor event. Same request and same payload return the prior result; same request and different payload reject.

Agent proposals do not call this write path until applied by a human or checked against an auto-apply grant. The event's actor is the person or agent who effected the write; proposedBy and suggestionId preserve the origin. Atomic multi-record proposals must not leave a Task behind when a Lead update conflicts.

The event ID links timeline, audit, undo proposals, webhook delivery and automation runs. Event history is append-only. Undo is a new validated change, never deletion of history. Redaction and field/record permissions must apply to before/after snapshots as well as live records. Automation retry idempotency is per action as well as per triggering event so partial work cannot duplicate children.

Pending proof: rollback on rejection, actor attribution, replay/conflict behavior, relation validation and isolation tests belong to the corresponding approved build steps. This ADR is a design contract, not a claim those features exist.
