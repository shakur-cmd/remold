# Production deploy, rollback and backups

Production is `app.remoldcrm.com` (Cloudflare Worker serving `dist/`) on Convex `nautical-viper-899`.
`prod.json` names that target; it holds no secrets. Fill its `PLACEHOLDER` values (the WorkOS staging client id and the callback registered on it, `https://app.remoldcrm.com/callback` per the 2026-09-29 go-live) and commit them. The build refuses while any placeholder is left.

All commands need `CONVEX_DEPLOY_KEY` set to a production deploy key for `nautical-viper-899` (Convex dashboard, Settings, Deploy keys). Anything else is refused, so `.env.local` can never choose the database. Wrangler uses its usual login.

## Deploy

    pnpm deploy:prod --dry-run   # every check and the build; prints the deploy commands
    pnpm deploy:prod

It refuses a dirty tree, a detached HEAD and a commit that no branch on origin contains (it fetches with --prune first). It checks the commit out into a fresh worktree, runs typecheck, tests, test:authority and verify:release, builds with the `prod.json` values only, refuses a bundle that names any other deployment, then runs `convex deploy` and `wrangler deploy`.

## Back up and drill

    pnpm backup:prod                      # into $REMOLD_BACKUP_DIR, default ~/Documents/CodeMyVibe/Backups/remold
    pnpm backup:drill <that zip>          # restore into a throwaway local backend, compare every table

Backups are never deleted by these scripts. The drill trusts only a zip whose checksum `SHA256SUMS` recorded at export.

## Roll back without losing data

    pnpm backup:prod
    pnpm deploy:prod --ref <older sha> --snapshot <the zip just made>

Before the deploy, revoke every website intake key (Settings → Agents, each "Website intake key" → Revoke). This step is required: code from before the 2026-10-03 release does not check a key's purpose, so it would accept an intake key on every agent route instead of only `/api/v1/intake/lead`. Issue new intake keys after rolling forward again.

This puts older code (functions and frontend) on the same database, so everything written since stays. It refuses a ref older than `rollbackTarget` in `ops/release/notes.json` or before the I1 authority floor, and a ref whose schema rejects the backup in a local restore.

Do not use the 2026-09-29 Cloudflare rollback (`wrangler rollback 8f0763b2-…`) except as a last resort. It points the site back at the old `gallant-pika-581` database: everything written since the switch disappears from the app and would have to be copied back by hand.
