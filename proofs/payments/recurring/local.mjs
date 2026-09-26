import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, cpSync, writeFileSync, readFileSync, existsSync, symlinkSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, dirname, basename } from 'node:path';
const here = fileURLToPath(new URL('.', import.meta.url)), base = fileURLToPath(new URL('../', import.meta.url)), root = fileURLToPath(new URL('../../../', import.meta.url));
const hash = x => createHash('sha256').update(x).digest('hex');
export async function withRecurring(check, { baseline = false, resumeDirectory } = {}) {
    assert.equal(JSON.parse(readFileSync(root + 'node_modules/convex/package.json')).version, '1.46.0');
    if (!existsSync(here + 'node_modules'))
        symlinkSync(root + 'node_modules', here + 'node_modules', 'dir');
    const frozen = JSON.parse(readFileSync(here + 'evidence/base-manifest.json'));
    const verify = () => {
        for (const [n, h] of Object.entries(frozen.files))
            assert.equal(hash(readFileSync(base + n)), h, n);
    };
    verify();
    mkdirSync(here + 'private', { recursive: true, mode: 0o700 });
    let cwd;
    if (resumeDirectory) {
        assert.equal(baseline, false);
        cwd = realpathSync(resumeDirectory);
        assert.equal(dirname(cwd), realpathSync(here + 'private'), 'Owned local proof directory required');
        assert(/^local-[A-Za-z0-9]+$/.test(basename(cwd)), 'Owned local proof directory required');
        assert.equal(realpathSync(cwd + '/.convex'), cwd + '/.convex', 'Local state must remain inside the proof directory');
        const localEnv = new Map();
        for (const line of readFileSync(cwd + '/.env.local', 'utf8').split('\n')) {
            const match = /^([A-Z_]+)=(.*)$/.exec(line);
            if (match) {
                assert(['CONVEX_DEPLOYMENT', 'CONVEX_URL', 'CONVEX_SITE_URL', 'VITE_CONVEX_URL'].includes(match[1]), 'Unapproved local environment key');
                assert(!localEnv.has(match[1]), 'Repeated local environment key');
                localEnv.set(match[1], match[2]);
            }
        }
        assert(localEnv.get('CONVEX_DEPLOYMENT')?.startsWith('anonymous:'), 'Only anonymous local proof state may resume');
        for (const n of ['schema.ts', 'recurring.ts', 'recurringFixture.ts', 'cadence.ts'])
            assert.equal(hash(readFileSync(cwd + '/convex/' + n)), hash(readFileSync(here + n)), 'Local proof source changed: ' + n);
        assert.equal(hash(readFileSync(cwd + '/convex/payment_schema.ts')), hash(readFileSync(base + 'convex/schema.ts')));
        for (const [name,digest] of Object.entries(frozen.files))
            if (name.startsWith('convex/') && name !== 'convex/schema.ts' && !name.startsWith('convex/_generated/'))
                assert.equal(hash(readFileSync(cwd + '/' + name)),digest,'Restored payment source changed: ' + name);
    } else {
        cwd = mkdtempSync(here + 'private/local-');
        cpSync(base + 'convex', cwd + '/convex', { recursive: true });
        if (!baseline) {
            cpSync(cwd + '/convex/schema.ts', cwd + '/convex/payment_schema.ts');
            for (const n of ['schema.ts', 'recurring.ts', 'recurringFixture.ts', 'cadence.ts'])
                cpSync(here + n, cwd + '/convex/' + n);
        }
        cpSync(base + 'tsconfig.json', cwd + '/tsconfig.json');
        writeFileSync(cwd + '/package.json', readFileSync(here + 'package.json'));
        writeFileSync(cwd + '/convex.json', '{"functions":"convex"}');
        symlinkSync(root + 'node_modules', cwd + '/node_modules', 'dir');
    }
    const cli = root + 'node_modules/convex/bin/main.js', env = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        CI: '1',
        CONVEX_AGENT_MODE: 'anonymous',
        CONVEX_DISABLE_METRICS: '1'
    }, rootEnv = existsSync(root + '.env.local') ? hash(readFileSync(root + '.env.local')) : null;
    let child, log = '';
    const run = (name, args = {}) => {
        try {
            const output = execFileSync(process.execPath, [cli, 'run', name, JSON.stringify(args)], {
                cwd,
                env,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe']
            });
            return output.trim() ? JSON.parse(output) : null;
        }
        catch {
            throw Error('Local call failed: ' + name);
        }
    };
    const start = async () => {
        log = '';
        child = spawn(process.execPath, [cli, 'dev', '--local-cloud-port', '3590', '--local-site-port', '3591', '--typecheck', 'enable', '--tail-logs', 'disable'], {
            cwd,
            env,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        for (const s of [child.stdout, child.stderr])
            s.on('data', b => log += b);
        const end = Date.now() + 180000;
        while (!log.includes('Convex functions ready')) {
            if (child.exitCode !== null || Date.now() > end)
                throw Error('Local backend not ready; private log retained');
            await new Promise(r => setTimeout(r, 150));
        }
    };
    const stop = async () => {
        if (child) {
            try {
                process.kill(-child.pid, 'SIGTERM');
            }
            catch {
            }
            await new Promise(r => child.once('close', r));
            child = null;
        }
    };
    try {
        await start();
        return await check({
            url: 'http://127.0.0.1:3590',
            run,
            cwd,
            restart: async () => {
                await stop();
                await start();
            }
        });
    }
    finally {
        writeFileSync(cwd + '/backend.log', log, { mode: 0o600 });
        await stop();
        verify();
        assert.equal(existsSync(root + '.env.local') ? hash(readFileSync(root + '.env.local')) : null, rootEnv);
    }
}
