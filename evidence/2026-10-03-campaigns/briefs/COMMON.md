# Remold build job: common rules (read fully before starting)

You are a builder on one job in Remold, Shakur's AGPL CRM (Convex + React + Vite, strict TypeScript, pnpm). A coordinator assigned this job, will merge your branch, and will have a different model verify it independently. Nobody can answer questions mid-job. Make sensible calls, write them down in the handover, and keep going until the "Done when" list passes.

## The philosophy
Remold is a CRM that an AI agent can quickly reshape to fit whoever uses it. Every feature should be drivable by an agent through the REST API and MCP server (packages/mcp) as well as by a person in the app, with agents proposing and people approving anything risky. Prefer building on the records/objects/fields metadata path, so agents can use the generic record tools, over new bespoke tables, except for high-volume system logs.

## Where
- You are in a git worktree of the repo. Create and work on the branch named in the job, based on the current HEAD (371a62c unless the job says otherwise). If node_modules is missing, run `pnpm install --frozen-lockfile`.
- Read AGENTS.md (project rules), then the files the job names.
- Code style: match the surrounding code. It is dense and terse; comments only for non-obvious reasons. Prefer the change that shrinks the system. Reuse what exists (records/objects/fields metadata, applyChange + events, authority checks in convex/authority, agentGuards, rate limiter, lib/email.ts) instead of adding parallel machinery.

## Hard limits
- Never touch production or any hosted service: no `convex deploy`, no `--prod`, no wrangler deploy, no real email sends, no calls to resend.com, stripe.com, app.remoldcrm.com or *.convex.cloud. Tests run locally (vitest + convex-test). Mock fetch in tests.
- No secrets in code, tests or commits. Env vars are read with process.env; list new ones in the handover.
- Schema changes are additive only (new tables, new optional fields). No destructive migration. New standard objects/fields reach existing orgs through the idempotent `seed:ensureStandard` path (convex/lib/standard.ts seedStandard); test that running it twice changes nothing the second time. State in the handover whether the previous release can still run against data written by this one.
- Do not push. Commit on the job branch.
- Commit messages: clear, imperative, end with the trailer line
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`

## Model routing
You own the result. For bulk mechanical implementation you may hand clear sub-specs to Codex: `codex exec -m gpt-5.6-terra --full-auto -C "$PWD" "<self-contained spec>" </dev/null` and review its diff line by line before committing. Do not let it commit. Taste work (UI, API shape, copy) stays with you.

## Proof rules (non-negotiable)
- For every behavior you add or fix: write the test first, run it, capture that it FAILS on the base code; then implement and capture that it passes. Record both (test name + fail/pass lines) in the handover.
- Tests describe behavior, not implementation, and must be able to fail.
- Before you finish, all must pass and you record their summary lines: `pnpm test`, `pnpm typecheck`, `pnpm test:authority`, `pnpm verify:release`, `pnpm build`. Baseline at 371a62c: test 329/329, typecheck clean, authority 101/101, release 37/37.
- UI: if you can, run the app against a local Convex backend (`npx` is not allowed; use `pnpm exec convex dev --local` or the scripts under ops/) and capture one screenshot per new screen into the handover folder with Playwright (headless Chromium is available via `pnpm dlx playwright` or ms-playwright cache). If you cannot get a local backend running, say so plainly instead of claiming the UI works.
- User-facing copy: plain, short, no em-dashes.

## Handover
Write `evidence/2026-10-03-campaigns/<job-id>/handover.md` in the repo (commit it) containing: branch and final commit hash; what changed (files, one line each); every decision you made and why; new env vars; fail-before/pass-after evidence per behavior; full-suite summary lines; rollback compatibility; owner setup steps needed to go live; anything left undone or uncertain, stated plainly. Screenshots go in the same folder. Your final message: the handover path and a five-line summary.

## Session rule
Run long commands in the foreground (up to 10 minutes per call; split longer work). Do not end your turn until the handover is written and committed.
