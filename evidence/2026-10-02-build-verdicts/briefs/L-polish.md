# Job L: polish from verifier notes
Branch: polish/2026-10-03. Job id: L-polish. Base: origin/release/2026-10-03 (live now). Small, each fix with a failing-first test where testable.
1. Today > Follow-ups: the overdue age label (e.g. "18 days ago") is clipped at the card's right edge on desktop. Fix the layout so the full label shows at desktop and phone widths; screenshot before/after with the local backend harness used by earlier jobs (see ~/work/handover/*/shot-harness if present on this machine, or ops/authority/local.mjs).
2. Funnel board: a column whose amounts sum to 0 hides its total (truthiness check in src/components/Board.tsx); show $0 when the amount field is readable.
3. Gmail sync (ops/gmail-sync/logic.js contactsOf): add the test Fable asked for: with the owner's own address as a Person, a mail from the owner to Ada with the owner cc'd posts only Ada's activity; it must fail if the !owners[address] check is removed.
4. REMOLD_INTAKE_DAILY_CAP parsing: accept only /^\d+$/ positive whole numbers ("1e3", "0x10", "+5" mean 0); tests.
5. Gmail sync WINDOW_DAYS: anything that is not a positive whole number falls back to the default; record LAST_ERROR when a run makes no progress; tests.
6. Docs: README.md still describes Clerk sign-in; update it to WorkOS AuthKit and the current deploy/backup commands (ops/deploy/README.md), briefly. Add "revoke website intake keys" as a required step in the rollback section of ops/deploy/README.md.
No schema changes expected; if one is needed, follow the rollback-target pattern. Run pnpm typecheck, pnpm test --maxWorkers=2 --testTimeout=15000, pnpm test:authority, pnpm verify:release, pnpm build. Handover as usual.
