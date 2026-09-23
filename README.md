# Remold

A CRM you reshape as you go: custom objects and fields without code, every change attributed, agents as team members. Built on Convex. AGPL-3.0-only.

**Status (2026-09-23): usable daily by a small team and their agents; on development infrastructure.** Sign in, create an organisation, invite your team by link, work People, Companies, Opportunities, Projects, Tasks, Notes and Campaigns, add your own objects and fields, and see every change in a timeline. Agents join as team members with a key: they read everything, propose changes you apply with one tap, and apply directly only what you grant them. See [Agents](#agents). The approved roadmap is in [docs/build-plan.html](docs/build-plan.html); the backend contract is [docs/spec/backend-v1.md](docs/spec/backend-v1.md); the records design decision is [docs/adr/001-records.md](docs/adr/001-records.md).

## Run it

Node 24+, pnpm 11. You need a Convex project and a Clerk application with a JWT template named `convex`.

```sh
pnpm install
cp .env.example .env.local        # fill VITE_CONVEX_URL and VITE_CLERK_PUBLISHABLE_KEY
pnpm exec convex dev              # first run creates the deployment and writes CONVEX_DEPLOYMENT
pnpm exec convex env set CLERK_JWT_ISSUER_DOMAIN https://<your-instance>.clerk.accounts.dev
pnpm dev
```

Create an organisation on first sign-in. In Settings you can run nothing destructive; the demo fixture is `pnpm seed` (fictional data, idempotent).

## Agents

Settings > Agents > Add agent gives you a key once (`rm_...`). Only its hash is stored. The key binds the agent to that one organisation.

- **REST**: `https://<deployment>.convex.site/api/v1` with `Authorization: Bearer rm_...`. Routes: `me`, `objects`, `records`, `records/{id-or-code}`, `.../events`, `.../related?field=person.company`, `search`, `today`, `suggestions` (GET, POST), `changes` (POST, needs a grant), `inbox` (GET, POST), `inbox/{id}/resolve`. Values are keyed by field key; lookups accept a record id, a three-word code or an exact title.
- **MCP**: `packages/mcp` is a stdio server over the same API, for Claude Code, Codex or any MCP client. See [packages/mcp/README.md](packages/mcp/README.md).
- **Suggestions**: an agent without a grant can only propose. The proposal remembers the values it saw; if someone changes them first, apply refuses and shows both. Applying twice does nothing the second time.
- **Inbox**: leave a note on Today ("For your agent"). The next agent session reads it first and proposes the records.

From the CLI, an admin can mint a key without signing in: `pnpm exec convex run agents:createAs '{"orgId":"...","userId":"...","name":"claude-mac"}'`.

## Checks

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @remold/mcp build && pnpm --filter @remold/mcp test
```

## Layout

- `convex/` backend: `identity.ts` (Clerk behind one module, `requireMember`, `requireAgent`), `http.ts` and `agentApi.ts` (the agent REST surface), `suggestions.ts`, `inbox.ts`, `agents.ts`, `lib/applyChange.ts` (the only record write path, appends `events`), `lib/slots.ts` (typed indexed slot allocation), `lib/standard.ts` (seeded objects), one file per public module.
- `src/` web app: Vite, React, Tailwind, shadcn. Routes under `src/routes`, generic form and value rendering under `src/components`.
- `evidence/` before and after runs for every claim in the log.

The benchmark spike that chose the records design lives on branch `spike/records`.

## Deploy

The web app is a Cloudflare Worker serving static assets (`wrangler.jsonc`), the backend is Convex.

```sh
pnpm build && pnpm dlx wrangler deploy     # https://remold.shakur-949.workers.dev
pnpm exec convex deploy                    # production backend, when we get there
```
