# Remold

A CRM you reshape as you go: custom objects and fields without code, every change attributed, agents as team members. Built on Convex. AGPL-3.0-only.

**Status (2026-09-22): first usable slice, ready for testing, awaiting verification.** Sign in, create an organisation, work People, Companies, Opportunities, Projects, Tasks and Notes, add your own objects and fields, and see every change in a timeline. The approved roadmap is in [docs/build-plan.html](docs/build-plan.html); the backend contract is [docs/spec/backend-v1.md](docs/spec/backend-v1.md); the records design decision is [docs/adr/001-records.md](docs/adr/001-records.md).

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

## Checks

```sh
pnpm typecheck
pnpm test
pnpm build
```

## Layout

- `convex/` backend: `identity.ts` (Clerk behind one module, `requireMember`), `lib/applyChange.ts` (the only record write path, appends `events`), `lib/slots.ts` (typed indexed slot allocation), `lib/standard.ts` (seeded objects), one file per public module.
- `src/` web app: Vite, React, Tailwind, shadcn. Routes under `src/routes`, generic form and value rendering under `src/components`.
- `evidence/` before and after runs for every claim in the log.

The benchmark spike that chose the records design lives on branch `spike/records`.
