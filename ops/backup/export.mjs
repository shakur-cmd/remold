// pnpm backup:prod: exports production into REMOLD_BACKUP_DIR (default ~/Documents/CodeMyVibe/Backups/remold)
// and appends its checksum to SHA256SUMS there. Never deletes or overwrites a backup.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTarget, requireDeployKey } from '../deploy/prod.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');

export async function exportBackup({ dir, deployment, key, now, exportZip }) {
  requireDeployKey(key, deployment);
  // The CLI runs from a temporary directory, so a relative path would land there and be deleted.
  dir = resolve(dir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${deployment}-${now.toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '')}.zip`);
  if (existsSync(path)) throw new Error(`${path} already exists`);
  await exportZip(path);
  appendFileSync(join(dir, 'SHA256SUMS'), `${sha256(path)}  ${basename(path)}\n`);
  return path;
}

// Runs outside the repo, with only the deploy key, so no .env.local or CONVEX_DEPLOYMENT can pick the deployment.
function convexExport(path) {
  const cwd = mkdtempSync(join(tmpdir(), 'remold-backup-'));
  // The CLI refuses to run without a package.json in its working directory.
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'remold-backup', private: true, dependencies: { convex: '*' } }));
  try { execFileSync(process.execPath, [join(root, 'node_modules/convex/bin/main.js'), 'export', '--prod', '--path', path], { cwd, stdio: 'inherit', env: { PATH: process.env.PATH, HOME: process.env.HOME, CONVEX_DEPLOY_KEY: process.env.CONVEX_DEPLOY_KEY } }); }
  finally { rmSync(cwd, { recursive: true, force: true }); }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { deployment } = readTarget(join(root, 'ops/deploy/prod.json'));
    const path = await exportBackup({ dir: process.env.REMOLD_BACKUP_DIR || join(homedir(), 'Documents/CodeMyVibe/Backups/remold'), deployment, key: process.env.CONVEX_DEPLOY_KEY, now: new Date(), exportZip: convexExport });
    console.log(`${sha256(path)}  ${path}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
