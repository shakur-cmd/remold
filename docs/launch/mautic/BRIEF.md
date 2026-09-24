# Brief: integrate Mautic with Remold, move Remold to remoldcrm.com

Date: 2026-09-24. Driver: Opus 5.5 (Claude Code, coordinating only). Author: Fable (claude-fable-5). Challenger: Astra (gpt-6-astra).

## User's words
"Come up with a plan to integrate https://github.com/mautic/mautic with remold. I have the domain remoldcrm now in cloudflare, have Astra set it up. We need to plan on integrating and improving the CRM as fast as possible but without breaking anything for anyone using it."

## Who
Shakur runs CodeMyVibe (small web/AI agency, outreach-driven). Remold is his own CRM (public AGPL-3.0, github.com/shakur-cmd/remold, local ~/Documents/CodeMyVibe/Projects/remold). He values: the change that shrinks the system, fast delivery, proof over claims, never breaking people's data.

## Facts (verified 2026-09-24 unless noted)
- Remold: Vite/React/TS on Cloudflare Workers static assets (remold.shakur-949.workers.dev, wrangler.jsonc), Convex backend on the DEV deployment gallant-pika-581 (near Free-plan limits), Clerk DEVELOPMENT instance (100-user cap, dev banner). main at e8cff1a, Astra APPROVED at 8418a31, 49 backend + 2 MCP tests.
- Features: custom objects/fields (slot-indexed records), links, events log via applyChange, Today page, board, search, CSV import/export, browser extension, agents with keys, REST (/api/v1 on convex.site), MCP server (packages/mcp), suggestions queue, agent inbox, three-word record codes.
- Users today: Shakur's org "Codemyvibe" with real data and team members plus agent keys; sign-up is open so strangers may have orgs. Unknown how many.
- Identity: users keyed by Convex identity.tokenIdentifier (issuer|subject). A new Clerk production instance has a different issuer and different user IDs, so a naive switch orphans every existing user from their org. This is the main "don't break anyone" risk.
- remoldcrm.com: registered at Cloudflare Registrar 2026-09-23, Cloudflare nameservers, no records yet. Wrangler on the Mac is logged in with write scopes.
- Existing roadmap: crm-evaluation/PLAN.md (Steps 0-13). Not built: Step 8 automation, Step 9 Gmail/Calendar sync, Step 10 sequences, Step 11 reports, production Clerk/Convex, REST rate limiting. PLAN.md excluded "marketing forms and landing pages".
- Mautic: open-source marketing automation, PHP/Symfony, MySQL/MariaDB, needs cron workers and an email transport (SMTP/API such as Amazon SES, Postmark, SendGrid). Latest release 7.2.1 (2026-09-23). GPL-3.0 (GitHub shows NOASSERTION; confirm). Has REST API (OAuth2 or basic auth), webhooks, contacts, companies, segments, campaigns, emails, forms, landing pages, tracking pixel/JS, points/stages, plugin system including CRM integrations. Official Docker image mautic/mautic. Cannot run on Cloudflare Workers; needs a VPS or container host.
- Decision log: ~/Documents/CodeMyVibe/Business/agent-setup/log/decisions.jsonl (grep remold).

## Interpretation the driver proposes (author may challenge)
- Remold stays the system of record for people, companies, deals. Mautic owns bulk email, campaigns, segments, forms, landing pages, tracking. Sync links them.
- Build the connector generic (an org admin enters their Mautic URL and credentials), host one Mautic for CodeMyVibe first. No multi-tenant Mautic hosting for others in v1.
- Using Mautic may replace or shrink roadmap Step 10 (sequences) and part of Step 8; say so if it does.
- Production cut-over (remoldcrm.com, Clerk prod, Convex prod) must preserve every existing user's org membership and data, with a rollback.

## Open user-owned choices (list them in the plan's decision block with a recommendation; do not assume answers)
e.g. where Mautic is hosted and its monthly cost, which email sending provider, root domain vs app. subdomain, whether open sign-up stays open during cut-over.

## Plan requirements (triad-v2)
Each step: Outcome, Build, Prove it (start state, action, observable result, pass/fail, a failure/recovery case), Evidence and verifier (builder cannot certify). All checks PENDING. Order steps so the fastest real value lands first and nothing live breaks. End with one end-to-end user journey and unresolved risks. Keep it as short as it can be.

---

# Brief v2 (2026-09-24, supersedes the priorities above where they differ)

## Shakur's new words
"Do as many passes as needed until everything is settled. The planning step is the most important so keep pushing and be bold. Even if we need to switch the auth from Clerk to WorkOS that's fine. Right now we are looking and building. The most important things are:
1) We are able to change things quickly even once other groups and teams are using it
2) We are able to charge potential customers.
3) Things stay simple for users when they are getting started"

## New verified facts (driver, 2026-09-24)
- Dev deployment gallant-pika-581 holds 1 user (Shakur), 1 org (Codemyvibe), 1 member, 2 agent keys, 16 records. Decision log says the 16 records are fictional seed data. So the r1-r3 migration machinery (relink inventory, freeze, cut-over rehearsal) protects essentially nobody today. Re-deciding auth and prod setup is cheap NOW and expensive later.
- remoldcrm.com: app.remoldcrm.com live on the existing Worker (commit 24b8a7d), apex/www 301 to app.
- WorkOS AuthKit: first 1M active users free; SSO (SAML/OIDC) USD 125 per connection per month (workos.com/pricing). Convex documents a first-party WorkOS AuthKit integration (docs.convex.dev/auth/authkit).
- Clerk: Billing add-on 0.7% of billing volume (plus Stripe fees) (clerk.com/pricing). Remold currently uses Clerk dev with the Convex integration; users keyed by tokenIdentifier.
- Convex pricing page lists Preview deployments on all plans including Free; Professional USD 25 per developer per month (convex.dev/pricing). Verify further details (e.g. preview deployments + Cloudflare, Convex migrations component) yourselves.
- DigitalOcean 2 GiB droplet USD 12/mo; Amazon SES USD 0.16 per 1,000 emails (Essentials tier).
- Mautic 7.2.1, GPL-3.0-or-later, PHP ~8.2, Docker image available. Its 7.2.1 reply parser needs a tracking pixel in reply HTML.

## What the plan must now deliver (in priority order)
1. Change speed that survives real customers: how Remold ships changes daily without breaking other teams' data or agents (staging/preview environments, schema migration discipline on Convex, per-org feature flags, versioned public REST/MCP contract, automated checks gating deploy, backups/restore, rollback of a bad deploy).
2. Charging: how a potential customer pays (plans, trial, checkout, subscription state enforced in the app, invoices, cancel/downgrade, what happens to data on non-payment). Pick the simplest billing path; compare Stripe direct, Clerk Billing, and anything better, then decide.
3. Simple start: a new team signs up, gets value in minutes, invites teammates, and connects an agent, without configuring anything.
4. Mautic integration, still wanted, but placed where it serves 1-3. Keep the hard-won r3 sync design (M4/M5) where it still applies. Decide whether Mautic is CodeMyVibe-only (marketing Remold itself / CodeMyVibe outreach) or a customer-facing connector, and when.

Auth decision (Clerk vs WorkOS AuthKit vs other) is open and should be decided in the plan on the merits of 1-3, with sources.
