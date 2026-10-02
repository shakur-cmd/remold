# Independent verification: Remold release 2026-10-02

**Verifier:** Claude Fable 5.1 (claude-fable-5-1), strictly read-only, 2026-10-02 ~05:50-06:00 UTC. Saved by the coordinator from the verifier's returned text (the verifier's harness blocked its own write).

## Verdicts
1. Bundle index-C_4BXwh8.js, nautical-viper-899 only: **PASS**. WorkOS client client_01M3AAH302D3TVVDJN9SBNYARF matches ops/deploy/prod.json. No secret-shaped strings.
2. Activity/Campaign/Invoice objects, time of day, Opportunity.campaign: **PASS**. Objects 7 -> 9 (campaign pre-existed), old objects byte-identical; fields 38 -> 52; task.dueDate gained withTime (additive).
3. 13 deleted / 3 kept / 68 imported / 71 live: **PASS**. Old 27 events unchanged; 68 import events attributed "import 2026-10-02", 13 "demo cleanup 2026-10-02". 64/64 lookups resolve. Credential scan of imported values: 0 hits. Nit: kept company is "Fictional Plumbing Co East".
4. Features: **PARTIAL PASS**. Seen: timeline with import attribution, Invoices panel, Campaign field, Today overdue tasks, Settings daily reminder and Protect-from-agents. Could not check without creating data: funnel board totals, invoice totals, Today times, Load more. Zero runtime errors across 8 pages.
5. Env names: **PASS** (no RESEND_API_KEY, as intended).

Cloudflare version b7140c9d: could not check (no Cloudflare access); bundle hash passes.

## Ops health
opsAlerts 0, opsNotices 0. integrations/lifecycle:sweep last ran 2026-09-29 (noted).

## Defects and observations
1. Cosmetic: Today "Workspace notes" placeholder names the deleted demo company ("Spoke with Dana at Atlas..."). Replace with neutral text.
2. Kept demo rows: "Fictional Plumbing Co East", "Ava Example", "Fictional Plumbing Website" (kept for edit history).
3. Funnel board, invoice totals, Today times and Load more unproven in production; SIM-level IVs cover the logic.
4. Daily reminder off and RESEND_API_KEY absent: no email can send yet.

Screenshots: 01-today.png ... 08-settings.png in this folder. Backup compared: nautical-viper-899-20261002T054759Z.zip.
