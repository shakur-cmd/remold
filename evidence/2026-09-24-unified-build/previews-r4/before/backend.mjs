import {isMain} from './state.mjs';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {scope,convexEnvironment,assertBackend} from './policy.mjs';
import {load,save,locked,verifyCI} from './state.mjs';
const here=fileURLToPath(new URL('.',import.meta.url));
export async function api(path,token) {
 const response=await fetch(`https://api.convex.dev/v1${path}`,{headers:{Authorization:`Bearer ${token}`}});
 assert(response.ok,`Convex metadata GET failed: ${response.status}`);return await response.json();
}
const safeLog=(text,key)=>text.replaceAll(key,'[redacted]').replaceAll(key.split('|').at(-1),'[redacted]');
const quote=text=>"'"+text.replaceAll("'","'\\''")+"'";
export async function backend(directory) {
 return await locked(resolve(directory),async()=>{
 const {dir,receipt,plan}=load(directory);assert.equal(receipt.phase,'prepared','A prior attempt requires reconciliation, not automatic retry');
 receipt.ci=verifyCI(plan);
 const cli=join(receipt.checkout,'node_modules/.bin/convex');assert(existsSync(cli),'Install exact frozen dependencies first');
 const key=readFileSync(join(here,'.private/convex-preview-key'),'utf8').trim(),env=convexEnvironment(process.env,key);
 // Personal credential is used only for these two read-only metadata requests, never passed to the CLI.
 const readToken=JSON.parse(readFileSync(join(homedir(),'.convex/config.json'),'utf8')).accessToken;
 const existing=await api(`/projects/${scope.projectId}/list_deployments`,readToken);
 assert(!existing.some(d=>d.previewIdentifier===plan.name||d.reference===`preview/${plan.name}`),'Preview name already exists; refuse unowned update');
 const defaults=await api(`/projects/${scope.projectId}/list_default_environment_variables?deploymentType=preview`,readToken);
 assert.equal(defaults.pagination.hasMore,false);assert.deepEqual(defaults.items,[],'Unreviewed inherited preview variables');
 const version=spawnSync(cli,['--version'],{cwd:receipt.checkout,env,encoding:'utf8'});assert.equal(version.stdout.trim(),'1.46.0');
 receipt.phase='backend-attempted';receipt.backendAbsentBefore=true;receipt.attemptedAt=new Date().toISOString();save(dir,receipt);
 const hook=`${quote(process.execPath)} ${quote(join(here,'bootstrap-env.mjs'))} ${quote(dir)}`;
 const args=['deploy','--preview-name',plan.name,'--typecheck','enable','--codegen','disable','--cmd',hook,'--cmd-url-env-var-name','PREVIEW_CONVEX_URL','--message',`I2 PR${plan.pr} ${plan.sha}`];
 const result=spawnSync(cli,args,{cwd:receipt.checkout,env,encoding:'utf8',maxBuffer:16*1024*1024});
 writeFileSync(join(dir,'backend-deploy.log'),safeLog((result.stdout||'')+(result.stderr||''),key),{flag:'wx'});
 assert.equal(result.status,0,'Backend deploy failed; preserve receipt and reconcile exact attempted preview');
 const after=load(dir).receipt;assertBackend(plan,after.backend);after.phase='backend-ready';save(dir,after);
 return {sha:plan.sha,backend:after.backend,phase:after.phase};
 });
}
if(isMain(import.meta.url)){
 try{console.log(JSON.stringify(await backend(process.argv[2]),null,2));}catch(e){console.error(e.message);process.exitCode=1;}
}
