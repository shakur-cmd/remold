// Starts a local anonymous Convex backend with the verbatim H0 contract and runs the P6 suite against it.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, readdirSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('.', import.meta.url));
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
// Mutant copies change the control plane on purpose; the real run must use H0 byte for byte.
if (!process.env.P6_MUTANT)
    for (const name of ['contract.ts', 'harness.ts', 'schema.ts'])
        if (sha(cwd + 'convex/' + name) !== sha(cwd + '../../contract/convex/' + name))
            throw new Error('convex/' + name + ' is not the verbatim H0 contract');
const allowedEnvironment = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TERM', 'CI', 'P6_ONLY', 'P6_RESULTS']);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowedEnvironment.has(key)));
env.CONVEX_AGENT_MODE = 'anonymous';
env.CONVEX_DISABLE_METRICS = '1';
for (const path of readdirSync(cwd).filter(name => name.startsWith('.env'))) {
    for (const line of readFileSync(cwd + path, 'utf8').split('\n').filter(line => line.trim() && !line.trim().startsWith('#'))) {
        const [key, ...parts] = line.split('='), value = parts.join('=').trim();
        const allowed = key === 'CONVEX_DEPLOYMENT' ? /^anonymous:[a-zA-Z0-9_-]+$/.test(value) : key === 'CONVEX_URL' ? /^http:\/\/127\.0\.0\.1:3810$/.test(value) : key === 'CONVEX_SITE_URL' ? /^http:\/\/127\.0\.0\.1:3811$/.test(value) : false;
        if (!allowed)
            throw new Error('Only anonymous loopback proof environment keys are allowed');
    }
}
if (!existsSync(cwd + 'node_modules'))
    symlinkSync('../../../node_modules', cwd + 'node_modules', 'dir');
const version = JSON.parse(readFileSync(cwd + 'node_modules/convex/package.json', 'utf8')).version;
if (version !== '1.46.0')
    throw new Error('Re-review the proof before changing its pinned Convex 1.46.0 dependency');
const args = [fileURLToPath(new URL('../../../node_modules/convex/bin/main.js', import.meta.url)), 'dev', '--local-cloud-port', '3810', '--local-site-port', '3811', '--typecheck', 'enable', '--tail-logs', 'disable', '--start', 'node p6.mjs'];
rmSync(cwd + 'evidence/.run-result.json', { force: true });
const child = spawn(process.execPath, args, { cwd, env, stdio: 'inherit', detached: true });
let resultCode, stopping = false;
function stop(code) {
    if (stopping)
        return;
    stopping = true;
    resultCode = code;
    clearInterval(timer);
    clearTimeout(deadline);
    try { process.kill(-child.pid, 'SIGINT'); } catch { }
}
const timer = setInterval(() => {
    if (existsSync(cwd + 'evidence/.run-result.json'))
        try { stop(JSON.parse(readFileSync(cwd + 'evidence/.run-result.json', 'utf8')).code); } catch { }
}, 200);
const deadline = setTimeout(() => { console.error('Proof exceeded its six-minute limit'); stop(1); }, 360000);
for (const signal of ['SIGTERM', 'SIGINT'])
    process.on(signal, () => stop(1));
child.on('error', error => { console.error(error); clearInterval(timer); clearTimeout(deadline); process.exitCode = 1; });
child.on('exit', code => { clearInterval(timer); clearTimeout(deadline); process.exitCode = resultCode ?? code ?? 1; });
