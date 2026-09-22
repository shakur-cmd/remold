# Remold backend v1: frozen contract

Date: 2026-09-22. Scope: the Convex backend for the first phone-testable slice (plan Steps 1, 2 and the data side of 4). Author: Fable. Builder: Codex terra. Reviewer: Fable. Everything here is a contract the UI is written against in parallel; change a name or shape only by editing this file first.

Constraints that apply to every line of code (from PLAN.md and AGENTS.md): every table except `users` carries `orgId`; every public query and mutation starts with `requireMember`; every record write goes through `applyChange` and appends an `events` row; no `.filter()` on tables that grow with usage, indexed reads only; paginate anything a user can scroll; Convex validators on all args; `ConvexError` with a `code` for every expected failure; strict TypeScript; vitest with `convex-test`.

## 1. Files

```
convex/
  schema.ts            tables and indexes exactly as in section 2
  auth.config.ts       Clerk provider: { domain: process.env.CLERK_JWT_ISSUER_DOMAIN, applicationID: "convex" }
  identity.ts          principal resolution and requireMember (section 3)
  errors.ts            fail(code, message, extra?) helper throwing ConvexError
  users.ts             store, me
  orgs.ts              create, mine, get, rename, members
  invites.ts           create, get, accept
  objects.ts           list, get, create
  fields.ts            list, create, update, retire
  records.ts           list, get, related, create, update, remove
  events.ts            forRecord, forOrg
  lib/slots.ts         allocateSlot, projections (section 4)
  lib/applyChange.ts   validation and the single write path (section 5)
  lib/standard.ts      standard object definitions (section 6)
  seed.ts              seedStandard (internal), demo (public, admin)
  *.test.ts            behavioural tests (section 8)
```

Model files are thin: validators, `requireMember`, call into `lib/`. No React, no UI types.

## 2. Schema

Types below use the `v` validator names. `Id<"x">` means `v.id("x")`.

```
users
  tokenIdentifier: string      from ctx.auth.getUserIdentity().tokenIdentifier
  name: string
  email: optional string
  imageUrl: optional string
  index by_token [tokenIdentifier]

orgs
  name: string
  createdBy: Id<users>

members
  orgId: Id<orgs>
  userId: Id<users>
  role: "owner" | "admin" | "member"
  index by_org_user [orgId, userId]
  index by_user [userId]

invites
  orgId: Id<orgs>
  token: string                 crypto.randomUUID()
  role: "admin" | "member"
  createdBy: Id<users>
  expiresAt: number             createdAt + 7 days, ms
  acceptedBy: optional Id<users>
  acceptedAt: optional number
  index by_token [token]
  index by_org [orgId]

objects
  orgId: Id<orgs>
  key: string                   lower camel, unique per org, immutable ("person", "job")
  label: string                 "Person"
  labelPlural: string           "People"
  icon: optional string         lucide icon name
  titleFieldId: optional Id<fields>   field whose value is the record's display title
  isStandard: boolean           seeded by us; still editable like any other
  order: number                 nav order
  index by_org [orgId]
  index by_org_key [orgId, key]

fields
  orgId: Id<orgs>
  objectId: Id<objects>
  key: string                   lower camel, unique per object, immutable
  label: string                 renameable
  type: "text" | "number" | "select" | "date" | "boolean" | "lookup" | "links"
  options: optional array of { id: string, label: string, color: optional string }   select only; ids stable, never reused
  targetObjectId: optional Id<objects>   lookup and links; absent on lookup means any object in the org (polymorphic)
  required: boolean
  slot: optional { kind: "n" | "s" | "d" | "b", index: number }   see section 4; absent means unindexed
  encoding: number              1
  retired: boolean              retired fields keep their slot forever
  order: number
  index by_object [orgId, objectId]
  index by_object_key [orgId, objectId, key]

records
  orgId: Id<orgs>
  objectId: Id<objects>
  values: record<string, any>   canonical values keyed by field _id (string). Narrowed by field metadata in applyChange. Missing key = empty.
  title: string                 denormalised display title, "" when the title field is empty
  createdBy: Id<users>
  updatedAt: number
  n0..n7: optional number       number projections
  s0..s7: optional string       text, select option id, lookup record id
  d0..d3: optional number       date as ms since epoch UTC; date-only values are UTC midnight
  b0..b3: optional boolean
  index by_object [orgId, objectId]
  index by_object_updated [orgId, objectId, updatedAt]
  one index per slot, named after it: by_n0 [orgId, objectId, n0] ... by_b3 [orgId, objectId, b3]   (24 indexes)

links                           rows for "links" (many-to-many) fields, one per pair
  orgId: Id<orgs>
  fieldId: Id<fields>
  fromRecordId: Id<records>
  toRecordId: Id<records>
  index by_from [orgId, fieldId, fromRecordId]
  index by_to [orgId, fieldId, toRecordId]
  index by_record_any [orgId, fromRecordId]     for cleanup on delete
  index by_target_any [orgId, toRecordId]

events
  orgId: Id<orgs>
  actor: { kind: "user" | "agent" | "automation", id: string }   user => users _id
  action: "create" | "update" | "delete"
  objectId: Id<objects>
  recordId: Id<records>         kept after deletion as an audit reference
  before: record<string, any> | null     logical values keyed by field _id, only the fields that changed (create: null)
  after:  record<string, any> | null     same keys as before (delete: null)
  reason: optional string
  index by_record [orgId, recordId]
  index by_org [orgId]
```

Table count 8, records indexes 26 (limit 32). `values` and `before/after` use `v.record(v.string(), v.any())`; that is the only `any` in the backend and it is narrowed by field metadata before any write.

## 3. Identity boundary (`identity.ts`)

```ts
type Principal = { user: Doc<"users">; actor: { kind: "user"; id: string } };
type Membership = Principal & { member: Doc<"members">; org: Doc<"orgs"> };

getPrincipal(ctx): Promise<Principal>
  identity = await ctx.auth.getUserIdentity(); none => fail("UNAUTHENTICATED")
  user = users.by_token(identity.tokenIdentifier); none => fail("UNAUTHENTICATED", "Call users.store first")

requireMember(ctx, orgId, minRole?: Role): Promise<Membership>
  principal, then members.by_org_user(orgId, user._id); none or role below minRole => fail("FORBIDDEN")
  role order: member < admin < owner
```

Nothing client-sent identifies the caller. Clerk profile data never grants membership. The only functions that run without membership are `users.store`, `users.me`, `orgs.create`, `orgs.mine`, `invites.get` and `invites.accept`, each of which still requires an authenticated principal (except `invites.get`, which is unauthenticated read of `{orgName, role, expired}` only).

The `actor` object is derived here and passed down. `applyChange` never accepts an actor from a client.

## 4. Slot contract (`lib/slots.ts`)

Capacity per object: n 8, s 8, d 4, b 4. Type to kind: number => n; text, select, lookup => s; date => d; boolean => b; links => none (stored in `links` rows, not projected).

`allocateSlot(ctx, orgId, objectId, kind)`: reads all fields of the object (indexed, one object's fields are small), collects used indexes for that kind including retired fields, returns the lowest free index or `undefined` when exhausted. Runs inside the same mutation that inserts the field, so Convex serialisability makes it unique.

Rules:
- A field's slot is assigned at creation and never changes. Rename never touches storage. Retire keeps the slot reserved. No reuse.
- Exhausted capacity creates the field with `slot` absent. Such a field stores values in `values` but `records.list` refuses to sort or filter by it with `fail("UNINDEXED_FIELD")`. Never a scan.
- Type is immutable after creation.
- `projections(fields, values)` returns the `{n0: .., s3: ..}` object for a record from its canonical values: every slotted field of the object, `undefined` when the value is empty, so stale projections are cleared on update.
- Encoding: number as is (finite); text as is; select as option id; lookup as the target record `_id` string; date as ms since epoch (integer); boolean as is. `encoding: 1` on the field records this.
- Callers, views and events reference field `_id`, never slot names.

## 5. `applyChange` (`lib/applyChange.ts`)

```ts
type Change =
  | { action: "create"; orgId; objectId; values: Record<string, unknown>; reason? }
  | { action: "update"; orgId; recordId; values: Record<string, unknown>; reason? }   // partial: only keys present change
  | { action: "delete"; orgId; recordId; reason? }

applyChange(ctx: MutationCtx, membership: Membership, change: Change): Promise<{ recordId: Id<"records">; eventId: Id<"events"> }>
```

In one mutation, in this order; any failure throws before any write:
1. Load object (create) or record then object (update, delete); both must have `orgId === change.orgId`, else `fail("NOT_FOUND")`. Never reveal cross-org existence: the same NOT_FOUND for wrong org and for missing.
2. Load the object's fields. Every key in `change.values` must be a non-retired field `_id` of this object, else `fail("VALIDATION", ..., { fieldId })`.
3. Validate each value by type. Empty is `null` or `undefined` and means "clear". number: finite number. text: string. select: string equal to an option id. date: integer. boolean: boolean. lookup: string that is a record `_id` whose record exists, has this `orgId`, and whose `objectId` equals `targetObjectId` when set. links: array of such ids (same checks, target per element). On create, every `required` field must be non-empty. Failure: `fail("VALIDATION", message, { fieldId })`.
4. Compute the new canonical `values` (create: validated values; update: previous merged with validated partial, cleared keys removed). Compute `title` from `object.titleFieldId` (string of the value, "" if empty; for lookup use the target record's title). Compute projections.
5. Write: create => insert record; update => patch `values`, `title`, `updatedAt` and all projection slots; delete => delete record and every `links` row where it is `fromRecordId` or `toRecordId`. For links fields, reconcile `links` rows to the new array (insert missing, delete extra) on create and update.
6. Append the event. `before`/`after` carry only the changed field ids; create has `before: null`, delete has `after: null` and `before` = full previous values. `actor` comes from `membership.actor`.
7. Return ids.

Convex mutations are transactions, so a throw at any step writes nothing. A test asserts that explicitly.

## 6. Standard objects (`lib/standard.ts`, seeded by `orgs.create`)

Every org gets these on creation, all `isStandard: true`, same tables and code path as customer objects. Keys and field keys are the contract the UI uses for the demo journey.

```
company   (title: name)   name text required; domain text; city text; notes text
person    (title: name)   name text required; email text; phone text; title text; company lookup->company
opportunity (title: name) name text required; amount number; stage select [new New, contacted Contacted, qualified Qualified, proposal Proposal, won Won, lost Lost]; closeDate date; company lookup->company; person lookup->person
project   (title: name)   name text required; status select [active Active, paused Paused, done Done]; company lookup->company
task      (title: title)  title text required; dueDate date; done boolean; project lookup->project; blockedBy links->task; about lookup (polymorphic)
note      (title: body)   body text required; about lookup (polymorphic)
```

Option ids are the lower-case words shown first. Seeding allocates slots in the order listed.

## 7. Public functions

All args include `orgId` where the doc has one. Return shapes are plain objects; `Doc<"records">` is returned as is (the UI ignores slot fields). Pagination uses Convex `paginationOptsValidator` and returns the standard `{ page, isDone, continueCursor }`.

```
users.store()  mutation   upsert users by tokenIdentifier from ctx.auth (name, email, imageUrl). Idempotent. Returns userId.
users.me()     query      null when unauthenticated or not stored, else the user doc.

orgs.create({ name })            mutation  principal => insert org, owner member, seed standard objects. Returns orgId.
orgs.mine()                      query     [{ org, role }] for the principal; [] when unauthenticated.
orgs.get({ orgId })              query     requireMember => org doc.
orgs.rename({ orgId, name })     mutation  requireMember admin.
orgs.members({ orgId })          query     requireMember => [{ member, user: { _id, name, email, imageUrl } }].

invites.create({ orgId, role })  mutation  requireMember admin => { token, expiresAt }.
invites.get({ token })           query     unauthenticated; { orgName, role, expired: boolean } or null when unknown.
invites.accept({ token })        mutation  principal; unknown => NOT_FOUND; expired or accepted => INVITE_EXPIRED; already a member => returns orgId without change; else insert member with invite role, mark accepted. Returns orgId.

objects.list({ orgId })          query     requireMember => objects sorted by order.
objects.get({ orgId, objectId }) query     requireMember => { object, fields (not retired, by order) }.
objects.create({ orgId, key, label, labelPlural, icon? })  mutation  requireMember admin; key must match /^[a-z][a-zA-Z0-9]*$/ and be unused => objectId. A new object gets a required text field "name" as its title field.

fields.list({ orgId, objectId })   query    requireMember => fields including retired, by order.
fields.create({ orgId, objectId, key, label, type, options?, targetObjectId?, required? })  mutation  requireMember admin; validates key pattern and uniqueness, options non-empty for select with unique ids, targetObjectId in org; allocates slot => { fieldId, slot }.
fields.update({ orgId, fieldId, label?, options? })  mutation  requireMember admin; options may add or relabel, never remove an id that any record uses is NOT checked today, so: options may only be added or relabelled (removal => VALIDATION).
fields.retire({ orgId, fieldId })  mutation  requireMember admin; cannot retire the title field.

records.list({ orgId, objectId, sort?: { fieldId, direction: "asc" | "desc" }, filter?: { fieldId, value }, paginationOpts })
                                   query    requireMember. No sort/filter => by_object_updated desc. sort => the slot index of that field, filter => same index with eq. sort and filter on different fields together => UNSUPPORTED (today). Unslotted field => UNINDEXED_FIELD.
records.get({ orgId, recordId })   query    requireMember => { record, object, fields } or null (same null for wrong org).
records.related({ orgId, recordId, fieldId, paginationOpts })  query  requireMember. fieldId is a lookup field on some object whose target is this record's object (or polymorphic): returns records of that object whose slot equals recordId. For a links field: rows via links.by_to then get each record.
records.reverseFields({ orgId, objectId })  query  requireMember => [{ field, object }] every non-retired lookup/links field in the org whose targetObjectId is objectId or absent (polymorphic). The UI uses this to render "related" panels.
records.create({ orgId, objectId, values, reason? })   mutation  requireMember => applyChange create.
records.update({ orgId, recordId, values, reason? })   mutation  requireMember => applyChange update.
records.remove({ orgId, recordId, reason? })           mutation  requireMember => applyChange delete.

events.forRecord({ orgId, recordId })  query  requireMember => events by_record, newest first, each with actorName resolved for user actors. Not paginated today; cap 200.
events.forOrg({ orgId, paginationOpts })  query  requireMember => by_org desc.

seed.demo({ orgId })  mutation  requireMember admin. Idempotent: if the org already has a company named "Fictional Plumbing Co", return. Creates through applyChange: 3 companies, 4 people, 3 opportunities across stages, 1 project, 3 tasks (one blocked by another), 2 notes. All names obviously fictional.
```

Error codes: `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION` (with `fieldId` when about a field), `INVITE_EXPIRED`, `UNINDEXED_FIELD`, `UNSUPPORTED`, `SLOTS_EXHAUSTED` (only from a future "must be indexed" flag; today exhaustion yields an unslotted field and this code is unused). `fail(code, message, extra)` throws `new ConvexError({ code, message, ...extra })`.

## 8. Tests (`convex/*.test.ts`, convex-test)

Use `t.withIdentity({ tokenIdentifier: "clerk|user_a", name: "A" })` style identities; call `users.store` first. Tests read like a description of behaviour and each can fail on a real bug:

- `identity.test.ts`: unauthenticated calls to every membership function throw UNAUTHENTICATED; a stored user with no membership gets FORBIDDEN from `orgs.get`; `orgs.create` makes the caller owner and seeds the six standard objects with the exact field keys of section 6; `users.store` twice yields one user.
- `invites.test.ts`: B accepts A's invite and can then read the org; accepting twice is a no-op; an invite 8 days old is INVITE_EXPIRED and creates no membership; a member cannot create invites (admin only).
- `isolation.test.ts`: with orgs A and B and known ids from B (an object, a field, a record, an event), a member of A gets NOT_FOUND/FORBIDDEN from `records.get`, `records.update`, `records.remove`, `records.related`, `fields.create` on B's object, `events.forRecord`; creating a record in A with a lookup pointing at B's record is VALIDATION; after all of that, B's tables and events are byte-identical to before (collect and compare).
- `applyChange.test.ts`: create writes record, projections and one event with `before: null` and actor = the caller's user id; update writes only changed keys in before/after; delete removes links rows and writes an event with `after: null`; invalid select option, non-finite number, wrong-target lookup and missing required field each throw VALIDATION with the fieldId and write neither record nor event; title follows the title field on create and update.
- `slots.test.ts`: creating 9 number fields on one object gives indexes 0..7 then an unslotted field; retiring a field keeps its index reserved; `records.list` sorted by the unslotted field throws UNINDEXED_FIELD; sorted by a slotted number field returns records in numeric order across two pages of 50 (seed 120 records); filtered by select option returns exactly the matching records.
- `related.test.ts`: a company's `related` for person.company lists its people and not another company's; task.blockedBy links appear from both sides; deleting the blocking task removes the link.
- `seed.test.ts`: `seed.demo` twice creates the demo once; every demo record has an event.

## 9. Commands the builder runs before reporting

```
pnpm exec convex codegen      regenerates convex/_generated (does not deploy)
pnpm typecheck
pnpm test
```

Do not run `convex dev`, `convex deploy` or anything that pushes to a deployment; the reviewer deploys. Do not edit anything under `src/` or `docs/`. Do not commit.
