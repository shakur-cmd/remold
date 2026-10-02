// pnpm deploy:prod [--dry-run] [--ref <sha> --snapshot <backup.zip>] [--config <prod.json>, dry runs only]
// Builds and deploys one commit from a fresh worktree, so .env.local and stray files never ship.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { authorityFloorCheck, runChecks } from '../release/release.mjs';
import { restoreDrill } from '../release/snapshot.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ok = (cwd, ...args) => spawnSync('git', args, { cwd, stdio: 'ignore' }).status === 0;
const SESSION_MODES = ['', 'staging-live'];

// Backups need only the deployment; a build needs every frontend value filled in.
export function readTarget(path, { build = false } = {}) {
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const deployment = /^https:\/\/([a-z]+-[a-z]+-\d+)\.convex\.cloud$/.exec(config.convexUrl ?? '')?.[1];
  if (!deployment) throw new Error(`${path}: convexUrl must be https://<deployment>.convex.cloud`);
  if (!build) return { ...config, deployment };
  const left = Object.keys(config).filter(key => /PLACEHOLDER/i.test(String(config[key])));
  if (left.length) throw new Error(`${path} still has a placeholder in ${left.join(', ')}; fill it before building`);
  if (!/^client_[A-Z0-9]+$/.test(config.workosClientId ?? '')) throw new Error(`${path}: workosClientId must look like client_...`);
  if (!/^https:\/\/[^/]+\//.test(config.workosRedirectUri ?? '')) throw new Error(`${path}: workosRedirectUri must be https`);
  if (!SESSION_MODES.includes(config.authSessionMode)) throw new Error(`${path}: authSessionMode must be one of ${JSON.stringify(SESSION_MODES)}`);
  return { ...config, deployment };
}

// A deployment deploy key names its deployment, so the CLI cannot fall back to whatever .env.local selects.
export function requireDeployKey(key, deployment) {
  const name = key?.split('|')[0];
  if (!key) throw new Error(`CONVEX_DEPLOY_KEY is not set; create a production deploy key for ${deployment} in the Convex dashboard`);
  if (name !== `prod:${deployment}` || !key.includes('|')) throw new Error(`CONVEX_DEPLOY_KEY is for ${name}, not prod:${deployment}`);
}

// Returns the commit to ship. Without a ref, HEAD must be a branch whose commit is on origin, so what ships can be checked out again.
export function releasable(cwd, ref) {
  if (git(cwd, 'status', '--porcelain', '--untracked-files=all')) throw new Error('Refusing: the working tree has uncommitted or untracked changes');
  if (!ref && !ok(cwd, 'symbolic-ref', '-q', 'HEAD')) throw new Error('Refusing: HEAD is detached; check out a branch or pass --ref');
  const sha = git(cwd, 'rev-parse', '--verify', `${ref ?? 'HEAD'}^{commit}`);
  // Mirror origin's branches exactly; a ref left over from a branch deleted on origin proves nothing.
  if (!ok(cwd, 'fetch', '--quiet', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*')) throw new Error('Refusing: could not fetch origin to confirm the commit is pushed');
  if (!git(cwd, 'for-each-ref', '--contains', sha, 'refs/remotes/origin')) throw new Error(`Refusing: ${sha} is not on origin; push it first so the deployed code is recoverable`);
  return sha;
}

export function rollbackFloor(cwd, sha, pinned) {
  if (!ok(cwd, 'merge-base', '--is-ancestor', pinned, sha)) throw new Error(`Refusing: ${sha} is older than the rollback target ${pinned} pinned in ops/release/notes.json; its schema may reject data written since`);
}

// The Convex client's own error messages use this example URL.
const LIBRARY_EXAMPLES = ['happy-otter-123'];
export function checkBundle(dist, target) {
  const text = readdirSync(dist, { recursive: true }).filter(file => /\.(js|html|css)$/.test(file)).map(file => readFileSync(join(dist, file), 'utf8')).join('\n');
  const others = [...new Set([...text.matchAll(/([a-z]+-[a-z]+-\d+)\.convex\.(?:cloud|site)/g)].map(match => match[1]))].filter(name => name !== target.deployment && !LIBRARY_EXAMPLES.includes(name));
  if (others.length) throw new Error(`Built bundle names another deployment: ${others.join(', ')}`);
  for (const value of [target.convexUrl, target.workosClientId]) if (!text.includes(value)) throw new Error(`Built bundle does not contain ${value}`);
}

const frontendEnv = target => ({ VITE_CONVEX_URL: target.convexUrl, VITE_WORKOS_CLIENT_ID: target.workosClientId, VITE_WORKOS_REDIRECT_URI: target.workosRedirectUri, VITE_AUTH_SESSION_MODE: target.authSessionMode, VITE_WORKOS_API_HOSTNAME: '', VITE_ROUTER: 'browser' });
// Convex functions first: the new frontend may call functions the old backend lacks.
export const deployCommands = () => [['pnpm', 'exec', 'convex', 'deploy', '-y'], ['pnpm', 'dlx', 'wrangler@4.138.0', 'deploy']];
const baseEnv = () => Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'PNPM_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
const run = (command, cwd, env) => { const result = spawnSync(command[0], command.slice(1), { cwd, env, stdio: 'inherit' }); if (result.error || result.status !== 0) throw new Error(`Failed: ${command.join(' ')}`); };

async function main() {
  const { values: args } = parseArgs({ options: { 'dry-run': { type: 'boolean' }, ref: { type: 'string' }, snapshot: { type: 'string' }, config: { type: 'string' } } });
  const dry = !!args['dry-run'];
  if (args.config && !dry) throw new Error('--config is for dry runs; a real deploy always reads ops/deploy/prod.json');
  const target = readTarget(resolve(args.config ?? join(root, 'ops/deploy/prod.json')), { build: true });
  const sha = releasable(root, args.ref);
  if (args.ref) {
    rollbackFloor(root, sha, JSON.parse(readFileSync(join(root, 'ops/release/notes.json'), 'utf8')).rollbackTarget);
    const authority = authorityFloorCheck(root, sha);
    if (authority !== true) throw new Error('Refusing: ' + authority);
    if (!args.snapshot) throw new Error('Refusing: a rollback needs --snapshot <latest backup zip> to prove its schema accepts current data (pnpm backup:prod first)');
  }
  let key = 'not checked';
  if (dry) key = process.env.CONVEX_DEPLOY_KEY ? (() => { try { requireDeployKey(process.env.CONVEX_DEPLOY_KEY, target.deployment); return 'present, for this deployment'; } catch (error) { return 'WRONG: ' + error.message; } })() : 'not set (a real deploy refuses without it)';
  else requireDeployKey(process.env.CONVEX_DEPLOY_KEY, target.deployment);
  const tree = join(mkdtempSync(join(tmpdir(), 'remold-deploy-')), 'tree');
  git(root, 'worktree', 'add', '--detach', tree, sha);
  try {
    run(['pnpm', 'install', '--frozen-lockfile', '--prefer-offline'], tree, baseEnv());
    const local = readdirSync(tree).filter(name => name.startsWith('.env') && name !== '.env.example');
    if (local.length) throw new Error(`Refusing: the checkout contains ${local.join(', ')}`);
    runChecks([['pnpm', 'typecheck'], ['pnpm', 'test'], ['pnpm', 'test:authority'], ['pnpm', 'verify:release']], tree);
    if (args.ref) {
      const drill = await restoreDrill({ source: tree, snapshot: resolve(args.snapshot) });
      if (drill.result !== 'PASS') throw new Error(`Refusing: ${sha} schema did not accept the backup: ${drill.reason}`);
      console.log(`Rollback schema accepted ${args.snapshot}`);
    }
    run(['pnpm', 'build'], tree, { ...baseEnv(), ...frontendEnv(target) });
    checkBundle(join(tree, 'dist'), target);
    console.log(`Built ${sha} for ${target.convexUrl}; bundle names no other deployment`);
    // CONVEX_DEPLOYMENT or a stray VITE_ value from the caller's shell must not redirect the deploy.
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(VITE_|CONVEX_(?!DEPLOY_KEY$))/.test(name)));
    if (dry) {
      console.log(`Dry run: nothing deployed. CONVEX_DEPLOY_KEY: ${key}. A real run executes, in a fresh worktree of ${sha}:`);
      for (const command of deployCommands()) console.log('  ' + command.join(' '));
      return;
    }
    for (const command of deployCommands()) run(command, tree, env);
    console.log(`Deployed ${sha} to ${target.deployment} and app.remoldcrm.com`);
  } finally {
    git(root, 'worktree', 'remove', '--force', tree);
    rmSync(dirname(tree), { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
