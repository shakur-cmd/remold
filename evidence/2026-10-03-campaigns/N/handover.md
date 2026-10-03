# Job N handover: hosted MCP endpoint

- Branch: `remold/hosted-mcp`, based on `origin/integ/campaigns` df22614 (f94e828 plus the coordinator's instructions-quote fix, fast-forwarded before the registry move). Final commit: the commit that adds this file (see `git log -1`); code commit 4a9296c.
- Builder: Claude Opus 5.5. Not independently verified. Levels: SIM (convex-test, vitest) and SERVICE (anonymous local Convex backend `convex dev --local`, real MCP SDK client, headless Chrome). Nothing LIVE: no deploy, no hosted service touched.

## What changed

- `packages/mcp/src/tools.ts` (new): the one tool registry. Server info, instructions, 23 tools (name, description, JSON Schema input, mapping to a REST `/api/v1` request), the argument checker `conform`, and `callTool`. No imports, so it runs in Node and in Convex.
- `packages/mcp/src/server.ts` (new): the stdio MCP server built from the registry (SDK low-level `Server`).
- `packages/mcp/src/index.ts`: shrunk to env check plus stdio connect (was 39 dense lines of tool definitions).
- `packages/mcp/src/client.ts`: `RemoldClient` (23 methods) replaced by `httpSend`, one function that sends a tool's REST request.
- `packages/mcp/src/client.test.ts`: the old client tests rewritten against `callTool` + `httpSend` (same URLs and headers asserted), plus argument check tests.
- `packages/mcp/README.md`: hosted is the default; stdio is for offline and development.
- `convex/mcp.ts` (new): the Streamable HTTP endpoint (stateless JSON-response mode).
- `convex/http.ts`: `POST/GET/DELETE /mcp` route; the telemetry wrapper is now shared (`measured`) by REST and MCP.
- `convex/agentApi.ts`: `checkKey` internal query (the same `requireAgent` lookup REST uses), so messages that call no tool are still key-checked.
- `convex/mcp.test.ts` (new): 10 tests, hosted endpoint and stdio/hosted parity.
- `convex/test.helpers.ts`: `via(t)` (fetch routed to the test router) and `mcpTool(t, key)` (call a tool as the stdio server does).
- `convex/jobE.test.ts`, `shape.test.ts`, `automations.test.ts`, `lifecycle.test.ts`: moved off the deleted `RemoldClient` onto `mcpTool`; same assertions.
- `ops/authority/inventory.json`: row for `agentApi:checkKey`.
- `src/components/AgentsCard.tsx`: after a key is issued, shows the hosted Claude Code command, the Codex config.toml form, generic JSON, then REST.
- `package.json`, `pnpm-lock.yaml`: `@modelcontextprotocol/sdk` as a root devDependency (same ^1.30.0 the package uses) for the convex tests and the harness.

## Decisions and why

1. **Hosted tool calls run the REST router in-process.** Each tool maps to the REST request the stdio server sends; the hosted endpoint builds that `Request` and calls `responseFor` (the REST dispatcher) directly, not over HTTP. So key hash lookup, the agent write rate limit, `argumentsConform` body refusal (keyHash never reaches Convex logs), idempotency, permissions and error codes are the REST code itself. Parity is by construction, and the tests also prove it.
2. **Spec version.** The current spec is 2026-07-28 (modern, sessionless, per-request `_meta`, `server/discover`). The brief asked for initialize/initialized/tools/list/tools/call/ping, which is the legacy era every shipping client uses today (SDK 1.30 tops out at 2025-11-25). I implemented 2025-03-26, 2025-06-18 and 2025-11-25 in stateless JSON mode: no `Mcp-Session-Id`, GET and DELETE return 405 with `Allow: POST`, notifications and client responses get 202 with no body, unsupported `MCP-Protocol-Version` header gets 400, missing header is accepted (spec: assume 2025-03-26). Initialize echoes a supported requested version, else answers 2025-11-25. A modern-only 2026-07-28 client is not supported yet; its request gets a 400 without the modern `-32022` error, which per the spec makes a dual-era client fall back to initialize.
3. **Batches** (JSON arrays) get 400 / -32600. They were removed in 2025-06-18 and no SDK client sends them.
4. **Origin.** Any request with an `Origin` header gets 403. Agents call from servers and CLIs; there is no browser client to allow, and this is the spec's DNS-rebinding rule at its simplest. A browser-based MCP inspector will not work against it.
5. **Auth errors.** 401 with `WWW-Authenticate: Bearer` and JSON-RPC error `-32001`, `id: null`, same messages as REST. Intake keys get 403 (REST's FORBIDDEN), migrating workspaces 503. The key is checked on every POST, notifications included, before the body is parsed.
6. **Errors.** Unknown tool: JSON-RPC `-32602 "Unknown tool: <name>"` (spec protocol error). Bad tool arguments: a tool result with `isError: true` and `VALIDATION: Invalid arguments for <tool>: <what>`, before anything is called (spec: input validation is a tool execution error the model can fix). REST errors: `isError` with `CODE: message`, exactly as the stdio server always did. Unknown method `-32601`, bad envelope `-32600`, bad JSON `-32700`.
7. **No zod in the registry.** zod is not a root dependency and schemas had to be identical on both sides, so the registry holds JSON Schema built by small helpers and a 30-line checker. The generated schemas are byte-for-byte the ones the old zod server produced (`stdio-before-after.txt`); only the SDK's `execution.taskSupport` field and `listChanged: true` (never sent) are gone. Unknown keys are dropped, as zod did. zod stays in packages/mcp only because the SDK requires it as a peer.
8. **Telemetry** records `/mcp` responses under route `rest`. Adding an `mcp` literal to `opsMetrics.route` would make the previous release fail schema validation on rollback. Consequence: a tool error inside a 200 MCP response is not counted as a client error; 401/400/405 at the MCP layer are.
9. **Settings panel.** Job M's panel is not on this base, so I changed the existing issued-key block in `AgentsCard` (hosted forms first, REST last) rather than adding a new panel. The coordinator can move these three blocks into Job M's panel.
10. **Codex form** uses `http_headers` inline so it is one paste. Checked with codex-cli 0.160.0: `codex mcp get` parsed it as `transport: streamable_http`, header present. `claude mcp add --transport http ... --header` syntax checked against `claude mcp add --help`.

## New env vars

None.

## Fail before, pass after

- Base (no registry, no endpoint): `convex/mcp.test.ts` fails to load (`fail-before-1-base.txt`).
- Registry in place, no `/mcp` route: all 10 tests fail, for example `No HttpAction routed for /mcp` (`fail-before-2-no-endpoint.txt`).
- After: 10/10 pass (`pass-after.txt`):
  - a real MCP client initializes, lists every tool and calls one over Streamable HTTP
  - answers initialize, the initialized notification and ping per the stateless JSON mode
  - refuses a missing, malformed, unknown or revoked key with 401 and a JSON-RPC error, and writes nothing
  - answers malformed JSON-RPC, unknown methods and unknown tools with JSON-RPC errors, and checks arguments before calling anything
  - gives a scoped agent exactly its REST permissions: reads, proposals, refused applies and hidden fields (each MCP result compared text-for-text with the REST response for the same key)
  - shares the REST write rate limit with the agent's key
  - replays a write sent again with the same idempotency key and refuses the key for a different write
  - never puts the key or its hash in a response
  - records each MCP request in the same operational telemetry as REST
  - stdio and hosted MCP parity: list the same tools and instructions and give the same results and errors (real SDK client to the stdio server over an in-memory transport, and to the hosted endpoint, 15 calls compared incl. errors, plus one write each)
- packages/mcp: 12/12 (was 9). The 3 new tests (argument refusal, `__proto__` stays data, unknown tool) are on the new API, so they fail on base by import only.
- Mutants: 18/18 caught (`mutants.py`, `mutants.txt`), including: no key check on notifications, Origin allowed, batches accepted, unknown tool code, idempotency header dropped (hosted and stdio), 405, version echo, protocol header, REST body validation skipped, rate limit off, `/mcp` unmeasured, schema `required`/unknown keys/`maxItems`/integers, hosted tool list or instructions drifting.
- Base finding (fixed by coordinator as df22614, not by me): at f94e828 `pnpm --dir packages/mcp build` failed on unescaped quotes in the instructions; vitest did not import index.ts so it never caught it. The new parity test imports the server, so a broken registry now fails `pnpm test`.

## SERVICE run (local backend)

`live-harness.mjs` (log `live-harness.log`, transcript `live-transcript.json`, keys redacted): scratch copy on `convex dev --local` ports 3690/3691. This also proves Convex bundles `convex/mcp.ts` importing `../packages/mcp/src/tools.ts`. A real SDK `StreamableHTTPClientTransport` client: initialize, 23 tools, `remold_me`, list records, propose (replayed with the same idempotency key: identical), apply without grant `FORBIDDEN: No grant for update:company. Propose it instead.`, bad arguments `VALIDATION`, unknown tool `-32602`, no key 401, unknown key 401, GET 405, bad JSON 400/-32700. The built stdio server against the same backend: tool list, instructions and a `get_record` result identical to hosted. Telemetry report counted the calls (200/400/401 buckets).
Screenshot: `settings-agent-connect.png`, Settings agent card after issuing a key. Locally the URL shows the cloud port (3690) because the card derives the site URL by replacing `.convex.cloud` with `.convex.site`; on a real deployment it shows `https://<name>.convex.site/mcp`. The key in the screenshot is synthetic from a deleted scratch backend.

## Suites (`suites.txt`)

- `pnpm test`: 60 files, 576/576 (base 566 per the shape-lifecycle merge record; +10 here)
- `pnpm typecheck`: clean
- `pnpm test:authority`: 101/101
- `pnpm verify:release`: 37/37
- `pnpm build`: ok
- `pnpm --dir packages/mcp build`: ok; `pnpm --dir packages/mcp test`: 12/12

## Rollback

No schema change, no new tables or fields, no data written by this job except normal suggestions/inbox rows through the existing REST code and `opsMetrics` rows with route `rest`. The previous release runs against this data unchanged. Rolling functions back removes `/mcp` (404) and `agentApi:checkKey`; agents set up with the hosted URL stop connecting until switched to the stdio form, which still works.

## Owner setup to go live

None beyond a normal `pnpm deploy:prod`. After deploy, issuing an agent key in Settings shows the hosted commands. Existing stdio users need nothing; they can switch to the hosted command and drop the repo checkout.

## Left undone or uncertain

- Modern MCP 2026-07-28 (sessionless `_meta`, `server/discover`, `Mcp-Method`/`Mcp-Name` header checks) is not implemented; current clients do not need it yet.
- No UI unit test for the AgentsCard copy; it is covered by the screenshot only.
- Not tested with the real Claude Code or Codex CLIs against the local backend (that would use Shakur's subscription); the SDK client is the same transport they use.
- Each hosted tool call checks the key twice (once at the MCP layer, once in the REST dispatcher): one extra indexed read per call.
- Tool errors inside 200 MCP replies are not visible as client errors in telemetry (decision 8).
