# Remold agents v1: frozen contract

Date: 2026-09-23. Scope: plan Step 5, the backend and the MCP package. Agents become team members: each has a key, a role, and optional auto-apply grants. Everything an agent does goes through one REST surface; the MCP server is a thin client of that REST surface, so there is exactly one implementation. Author: Fable. Builder: Codex terra. Reviewer: Fable. Independent verifier: Astra.

Everything in `docs/spec/backend-v1.md` still applies: `orgId` on every table, indexed reads only, `applyChange` is the only record write path, `fail(code)` for expected errors, strict TypeScript, convex-test behaviour tests. Change a name or shape only by editing this file first.

## 1. Files

```
convex/
  schema.ts            add agents, suggestions, agentInbox; widen records.createdBy; add events.suggestionId (section 2)
  errors.ts            add code CONFLICT
  identity.ts          add AgentMembership, Principal union, requireAgent, granted (section 3)
  lib/applyChange.ts   accept Principal; createdBy from user or agent; optional suggestionId on the event (section 4)
  lib/values.ts        friendly values: by field key in, readable out (section 5)
  agents.ts            user-facing: list, create (action), setGrants, revoke
  suggestions.ts       user-facing: list, forRecord, apply, dismiss (section 6)
  inbox.ts             user-facing: list, add, remove
  agentApi.ts          internal functions the HTTP layer calls, all take keyHash (section 7)
  http.ts              httpRouter, Bearer auth, /api/v1 routes (section 8)
  events.ts            forRecord also resolves agent actor names and appliedByName
  agents.test.ts suggestions.test.ts inbox.test.ts rest.test.ts   (section 10)
packages/mcp/
  package.json src/index.ts src/client.ts src/client.test.ts README.md tsconfig.json   (section 9)
pnpm-workspace.yaml    add packages: ["packages/*"]
```

## 2. Schema

```
agents
  orgId: Id<orgs>
  name: string                 "claude-mac"
  role: "admin" | "member"     same meaning as members.role; agents are never owner
  createdBy: Id<users>
  keyHash: string              hex SHA-256 of the full key
  keyPrefix: string            first 12 characters of the key, e.g. "rm_3f9a2c1b", for display
  grants: array of { action: "create" | "update" | "delete", objectKey: string }   objectKey "*" means every object
  revokedAt: optional number
  index by_org [orgId]
  index by_key_hash [keyHash]

suggestions
  orgId: Id<orgs>
  agentId: Id<agents>
  status: "pending" | "applied" | "dismissed" | "conflicted"
  change: { action: "create" | "update" | "delete", objectId: Id<objects>, recordId: optional Id<records>, values: record<string, any> }
                               values are canonical (keyed by field _id, already resolved and validated at proposal time)
  before: record<string, any>  the current value of every field in change.values at proposal time (create: {}); delete: the full values
  reason: string
  inboxId: optional Id<agentInbox>
  resolvedBy: optional Id<users>
  resolvedAt: optional number
  eventId: optional Id<events>
  conflicts: optional array of { fieldId: string, expected: any, actual: any }
  index by_org_status [orgId, status]
  index by_record [orgId, recordId]

agentInbox
  orgId: Id<orgs>
  text: string
  source: string               "web", "extension", "api", or whatever the caller says; default "api"
  from: { kind: "user" | "agent", id: string }
  status: "pending" | "resolved"
  resolvedBy: optional Id<agents>
  resolvedAt: optional number
  note: optional string
  suggestionId: optional Id<suggestions>
  recordId: optional Id<records>
  index by_org_status [orgId, status]

records.createdBy: union(Id<users>, Id<agents>)      widened, no data migration needed
events.suggestionId: optional Id<suggestions>         set when the event came from applying a suggestion
```

Key format: `rm_` followed by 40 lower-case hex characters from `crypto.getRandomValues` (20 bytes). Hash: `crypto.subtle.digest("SHA-256")` as lower-case hex. The plain key is returned once from `agents.create` and never stored.

## 3. Identity (`identity.ts`)

```ts
type Actor = { kind: "user" | "agent" | "automation"; id: string };
type Membership = { user: Doc<"users">; member: Doc<"members">; org: Doc<"orgs">; actor: Actor };      // unchanged
type AgentMembership = { agent: Doc<"agents">; org: Doc<"orgs">; actor: { kind: "agent"; id: string } };
type Principal = Membership | AgentMembership;

requireAgent(ctx, keyHash: string): Promise<AgentMembership>
  agents.by_key_hash(keyHash); none or revokedAt set => fail("UNAUTHENTICATED", "Invalid or revoked agent key")
  org = get(agent.orgId); none => same failure

granted(agent: Doc<"agents">, action, objectKey): boolean
  agent.grants.some(g => g.action === action && (g.objectKey === "*" || g.objectKey === objectKey))

roleOf(principal): Role   member.role or agent.role
```

An agent is bound to exactly one org by its key. No route takes an `orgId` from an agent; the org comes from the key. That is the whole isolation story, and `rest.test.ts` proves it.

## 4. `applyChange`

Signature becomes `applyChange(ctx, principal: Principal, change, options?: { clearingReference?: boolean; suggestionId?: Id<"suggestions"> })`. `createdBy` is `principal.user._id` for a user, `principal.agent._id` for an agent (`"user" in principal`). `actor` is `principal.actor`. When `options.suggestionId` is set it is written onto the event. Nothing else changes.

## 5. Friendly values (`lib/values.ts`)

Agents speak in field keys and human names, not `_id`s. Two functions, both pure except for the lookups they resolve:

```ts
resolveValues(ctx, orgId, object, fields, input: Record<string, unknown>): Promise<Record<string, unknown>>
  keyed by field key. Unknown or retired key => fail("VALIDATION", `Unknown field "${key}"`, { fieldKey })
  text: string
  number: finite number (a numeric string like "1200" or "$1,200" is coerced; anything else => VALIDATION)
  boolean: boolean, or the strings "true"/"false"/"yes"/"no"
  date: integer ms, or "YYYY-MM-DD" (UTC midnight), or an ISO datetime (UTC midnight of that date)
  select: option id, or option label (case-insensitive) => id
  lookup: a record _id, a three-word code (lib/ref.ts isRef), or an exact title (lib/find.ts findByTitle, target object required; polymorphic lookup accepts id or code only). Not found => VALIDATION "No <Target> named ..." { fieldKey }
  links: array of the same
  null clears
  Output is keyed by field _id, ready for applyChange (which validates again; that is fine).

readable(ctx, orgId, record, object, fields): Promise<ApiRecord>
  { id, ref, object: object.key, title, createdAt: _creationTime, updatedAt,
    values: { [field.key]: value } } where lookup => { id, ref, title } | null, links => array of those,
    select => option id, date => "YYYY-MM-DD", everything else canonical. Empty fields are omitted. Retired fields are omitted.
```

## 6. Suggestions (`suggestions.ts`, user side)

```
suggestions.list({ orgId, status? })   query   requireMember. by_org_status (default "pending"), newest first, cap 200.
                                       Each row: { suggestion, agentName, objectKey, objectLabel, recordTitle (null on create), recordRef }
suggestions.forRecord({ orgId, recordId })   query   requireMember. by_record, pending and conflicted only, newest first.
suggestions.apply({ orgId, suggestionId })   mutation   requireMember (member is enough: a person applies what an agent proposed).
  Returns { status: "applied", recordId, eventId } | { status: "already", current: status } | { status: "conflicted", conflicts }.
  Rules, in order:
  1. suggestion.orgId !== orgId or missing => fail("NOT_FOUND").
  2. status !== "pending" => return { status: "already", current } and write nothing. This is the idempotency rule: two fast clicks give one event.
  3. update or delete: load the record. Missing (deleted meanwhile) => mark conflicted with conflicts [{ fieldId: "*", expected: before, actual: null }], return conflicted.
     update: for each fieldId in change.values, compare current record.values[fieldId] with before[fieldId] by JSON (null and undefined equal). Any difference => patch suggestion { status: "conflicted", conflicts: [{ fieldId, expected: before[fieldId] ?? null, actual: current ?? null }...] } and return { status: "conflicted", conflicts }. The record is untouched, no event.
  4. Build the AgentMembership for suggestion.agentId (revoked agents can still have their old suggestions applied; a revoked key only stops new calls). applyChange(ctx, agentMembership, change, { suggestionId }). The event's actor is the agent; the person is recorded on the suggestion.
  5. patch suggestion { status: "applied", resolvedBy: user._id, resolvedAt: now, eventId }. If applyChange returned eventId null (an update that changed nothing), still mark applied with no eventId.
  6. If suggestion.inboxId is set and that item is pending, mark it resolved with suggestionId (the agent's work is done once its suggestion is applied).
suggestions.dismiss({ orgId, suggestionId })   mutation   requireMember. pending or conflicted => dismissed with resolvedBy/resolvedAt; anything else => { status: "already" }.
```

`events.forRecord` rows gain `actorName` for agent actors (agents table name) and `appliedByName: string | null` (resolvedBy user's name when the event has a suggestionId).

## 7. Agent functions (`agentApi.ts`, internal, every one takes `keyHash: v.string()` and starts with `requireAgent`)

These are `internalQuery` / `internalMutation`. Read functions mirror the user queries but return readable shapes (section 5). Reuse the existing query logic by extracting it where the two would otherwise duplicate more than a few lines (for example move the body of `records.list` into `lib/list.ts` as `listRecords(ctx, orgId, objectId, sort?, filter?, paginationOpts)` and call it from both). Do not copy-paste index logic.

```
me()                        { org: { id, name }, agent: { id, name, role, grants }, pendingInbox: number, pendingSuggestions: number }
objects()                   [{ key, label, labelPlural, titleField: key | null, fields: [{ key, label, type, options?, target?: objectKey, required, indexed }] }]   retired fields omitted
listRecords({ object, cursor?, limit?, sort?: { field, direction }, filter?: { field, value } })   { records: ApiRecord[], cursor: string | null }   limit default 25 max 100; sort/filter by field key; same UNSUPPORTED / UNINDEXED_FIELD rules
getRecord({ idOrRef })      { record: ApiRecord, events: last 20 as { at, actor: { kind, name }, action, before, after, reason } with before/after keyed by field key } or NOT_FOUND
search({ q, object?, limit? })   ApiRecord[] (title search; without q, most recently updated of that object)
related({ idOrRef, field: "person.company" })   ApiRecord[] first 100; "objectKey.fieldKey" names the lookup/links field on the other object
today()                     { tasks: ApiRecord[], quiet: ApiRecord[] }   same rules as today.get; today = UTC midnight of the server's current date
propose({ action, object?, record?, values?, reason, inboxId? })   => { suggestion: ApiSuggestion }
  create needs object and values; update needs record and values; delete needs record. record is id or code.
  resolveValues first (VALIDATION surfaces here, before anything is written), then snapshot before, insert suggestion pending. No record write, no event.
change({ action, object?, record?, values?, reason })   => { record: ApiRecord | null (null after delete), eventId }
  granted(agent, action, objectKey) false => fail("FORBIDDEN", `No grant for ${action}:${objectKey}. Propose it instead.`) and nothing is written.
  Otherwise resolveValues then applyChange with the AgentMembership.
listSuggestions({ status? })   ApiSuggestion[] for this agent's org (all agents), default pending, cap 100
inbox({ status? })          ApiInboxItem[] default pending, oldest first (a queue), cap 100
inboxAdd({ text, source? })   ApiInboxItem   from = the agent
inboxResolve({ id, note?, suggestionId?, recordId? })   ApiInboxItem   pending only; already resolved => fail("CONFLICT", "Already resolved"). Records resolvedBy = this agent. suggestionId/recordId must belong to this org else NOT_FOUND.

ApiSuggestion: { id, status, action, object: key, record: { id, ref, title } | null, values: readable by key, before: readable by key, reason, agent: name, createdAt, resolvedAt, conflicts?: [{ field: key, expected, actual }] }
ApiInboxItem:  { id, text, source, from: { kind, name }, status, createdAt, resolvedAt, note, suggestionId, recordId }
```

## 8. HTTP (`http.ts`)

`httpRouter()`; the site URL is `https://<deployment>.convex.site`. Every route under `/api/v1`:

- Auth: `Authorization: Bearer rm_...`. Missing or malformed => 401 `{ "error": { "code": "UNAUTHENTICATED", "message": "..." } }`. The action hashes the key (SHA-256 hex, `crypto.subtle` is available in HTTP actions) and passes `keyHash` to the internal function. The plain key never reaches the database layer.
- JSON in (`Content-Type: application/json`), JSON out. Query parameters for GET. Unknown route => 404 with the same error shape.
- Error mapping from `ConvexError.data.code`: UNAUTHENTICATED 401, FORBIDDEN 403, NOT_FOUND 404, CONFLICT 409, VALIDATION / UNSUPPORTED / UNINDEXED_FIELD 400. The response body is `{ error: data }` (so `fieldKey` travels). Any other thrown error => 500 `{ error: { code: "INTERNAL", message: "Something went wrong" } }`, never the stack.

```
GET  /api/v1/me
GET  /api/v1/objects
GET  /api/v1/records?object=person&limit=25&cursor=...&sort=name&direction=asc&filter=stage&value=won
GET  /api/v1/records/{idOrRef}
GET  /api/v1/records/{idOrRef}/events
GET  /api/v1/records/{idOrRef}/related?field=person.company
GET  /api/v1/search?q=atlas&object=company&limit=10
GET  /api/v1/today
GET  /api/v1/suggestions?status=pending
POST /api/v1/suggestions          body { action, object?, record?, values?, reason, inboxId? }   201
POST /api/v1/changes              body { action, object?, record?, values?, reason }             200 (needs a grant)
GET  /api/v1/inbox?status=pending
POST /api/v1/inbox                body { text, source? }   201
POST /api/v1/inbox/{id}/resolve   body { note?, suggestionId?, recordId? }
```

Use `pathPrefix: "/api/v1/"` with one dispatcher that splits the remaining path, rather than one route per URL; keep the dispatcher a small table.

## 9. MCP package (`packages/mcp`)

`@remold/mcp`, `bin: { "remold-mcp": "dist/index.js" }`, deps `@modelcontextprotocol/sdk` and `zod`, dev `typescript`, `vitest`. `src/client.ts` is a tiny typed REST client taking `{ url, key, fetch? }` (fetch injectable for the test). `src/index.ts` starts a stdio `McpServer` named `remold` reading `REMOLD_URL` (the `.convex.site` origin) and `REMOLD_KEY` from the environment; exit with a one-line message if either is missing.

Server instructions (passed to McpServer): "Remold is the team's CRM. Records are named by a three-word code like brisk-ember-oyster; use codes or ids when you refer to one. Start with remold_inbox: pending items are work left for you. Prefer remold_propose_change; a person applies it. remold_apply_change only works for actions the team granted you."

Tools (one per section 7 function, names and argument shapes mirror it, descriptions written for a model reading them cold):
`remold_me`, `remold_objects`, `remold_list_records`, `remold_get_record`, `remold_search`, `remold_related`, `remold_today`, `remold_propose_change`, `remold_apply_change`, `remold_list_suggestions`, `remold_inbox`, `remold_inbox_add`, `remold_inbox_resolve`.
Each tool returns the JSON body pretty-printed as text; an error response returns `isError: true` with the error message and code.

README: what it is, `pnpm --filter @remold/mcp build`, the exact `claude mcp add remold -e REMOLD_URL=... -e REMOLD_KEY=... -- node <abs path>/packages/mcp/dist/index.js` line and the Codex `~/.codex/config.toml` equivalent, and a curl example against REST.

`src/client.test.ts`: with an injected fetch, `propose` sends POST `/api/v1/suggestions` with the Bearer header and body; a 403 body becomes a thrown error carrying `code`.

## 10. Tests (convex-test; use `t.fetch` for HTTP routes, `t.withIdentity` for people)

Helper in `test.helpers.ts`: `agentFor(client, orgId, { name, role?, grants? })` => `{ agentId, key }` via `agents.create`; `rest(t, key)` => `(method, path, body?) => Promise<{ status, json }>`.

- `agents.test.ts`: an admin creates an agent and receives a key starting `rm_` of length 43 once; `agents.list` shows keyPrefix and never keyHash or the key; a member (role member) gets FORBIDDEN from create; after `revoke`, `GET /api/v1/me` with that key is 401; `setGrants` replaces the array.
- `rest.test.ts`: no header, wrong key, and a key from another org against that org's data all give 401 or return only the key's own org (assert org id in `/me` and that `/records?object=company` lists only the key's org's companies while org B has a company too); `POST /suggestions` with `{ action: "update", record: <code>, values: { stage: "Won" } }` creates one pending suggestion whose `before.stage` is the current stage, and afterwards the record and the events table are unchanged (collect and compare); `POST /changes` for `update:opportunity` without a grant is 403 and writes no record and no event; with grant `create:task` and values `{ title: "Call back", dueDate: "2026-10-01", about: <company title> }` returns 200, the task exists with the lookup resolved, `createdBy` is the agent id, and the event actor is `{ kind: "agent", id }`; values `{ stage: "Nonsense" }` give 400 with `fieldKey: "stage"`; `GET /records/<code>` returns readable values with the company lookup expanded to `{ id, ref, title }`; unknown path 404.
- `suggestions.test.ts`: a person applies a pending update suggestion; the record changes, the event has actor agent, `suggestionId`, and `events.forRecord` shows `actorName` = agent name and `appliedByName` = the person; the suggestion is applied with resolvedBy. Applying again returns `already` and the events count for the record is unchanged. The person edits the targeted field first, then applies: result `conflicted`, `conflicts[0]` carries expected and actual, the person's value is still on the record, and no new event. A member of another org gets NOT_FOUND from apply and nothing changes. Dismiss moves pending to dismissed. A create suggestion applied twice yields exactly one record.
- `inbox.test.ts`: a person adds an item; `GET /inbox` for the agent lists it first (oldest first with two items); `POST /inbox/{id}/resolve` with a suggestionId links it and it leaves the pending list; resolving again is 409; a suggestion that is applied whose `inboxId` points at a pending item resolves that item.

## 11. Commands the builder runs before reporting

```
pnpm install                        (workspace now includes packages/mcp)
pnpm exec convex codegen
pnpm typecheck
pnpm test
pnpm --filter @remold/mcp build && pnpm --filter @remold/mcp test
```

Do not run `convex dev` or `convex deploy`. Do not edit anything under `src/` (the web UI is built separately against this contract) or `docs/` other than this file's companion README in `packages/mcp`. Do not commit.
