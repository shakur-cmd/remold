import {isMain} from './state.mjs';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {scope,convexEnvironment,assertBackend,reconcileBackend,assertBackendRecovery} from './policy.mjs';
import {load,save,locked,verifyCI} from './state.mjs';
const here=fileURLToPath(new URL('.',import.meta.url));
export async function api(path,token) {
 const response=await fetch(`https://api.convex.dev/v1${path}`,{headers:{Authorization:`Bearer ${token}`}});
 assert(response.ok,`Convex metadata GET failed: ${response.status}`);return await response.json();
}
const safeLog=(text,key)=>text.replaceAll(key,'[redacted]').replaceAll(key.split('|').at(-1),'[redacted]');
const quote=text=>"'"+text.replaceAll("'","'\\''")+"'";
export async function backend(directory,recovery) {
 return await locked(resolve(directory),async()=>{
 const {dir,receipt,plan}=load(directory);assert.equal(receipt.phase,recovery?'backend-attempted':'prepared','A prior attempt requires explicit reconciliation');
 receipt.ci=verifyCI(plan);
 const cli=join(receipt.checkout,'node_modules/.bin/convex');assert(existsSync(cli),'Install exact frozen dependencies first');
 const key=readFileSync(join(here,'.private/convex-preview-key'),'utf8').trim(),env=convexEnvironment(process.env,key);
 // Personal credential is used only for these two read-only metadata requests, never passed to the CLI.
 const readToken=JSON.parse(readFileSync(join(homedir(),'.convex/config.json'),'utf8')).accessToken;
 const existing=await api(`/projects/${scope.projectId}/list_deployments`,readToken);
 const matches=existing.filter(d=>d.previewIdentifier===plan.name||d.reference===`preview/${plan.name}`);
 if(!recovery)assert.equal(matches.length,0,'Preview name already exists; refuse unowned update');
 const defaults=await api(`/projects/${scope.projectId}/list_default_environment_variables?deploymentType=preview`,readToken);
 assert.equal(defaults.pagination.hasMore,false);assert.deepEqual(defaults.items,[],'Unreviewed inherited preview variables');
 const version=spawnSync(cli,['--version'],{cwd:receipt.checkout,env,encoding:'utf8'});assert.equal(version.stdout.trim(),'1.46.0');
 if(recovery){
  assert.equal(matches.length,1);
  const candidate=reconcileBackend(plan,await api(`/deployments/${recovery.name}`,key),matches);
  assertBackendRecovery(plan,receipt,candidate,recovery.name,recovery.id);
  const run=(args)=>{const r=spawnSync(cli,args,{cwd:receipt.checkout,env,encoding:'utf8'});assert.equal(r.status,0,'Recovery inventory read failed');return {args,stdout:r.stdout,stderr:r.stderr};};
  const functions=run(['function-spec','--deployment',candidate.name]);
  assert.deepEqual(JSON.parse(functions.stdout),{url:candidate.deploymentUrl,functions:[]},'Recovery requires an unpushed backend');
  const data=run(['data','--deployment',candidate.name]);assert.equal(data.stdout.trim(),'');assert.equal(data.stderr.trim(),`There are no tables in the ${candidate.name} deployment's database.`);
  const variables=run(['env','list','--preview-name',plan.name]);assert.equal(variables.stdout.trim(),'');assert.equal(variables.stderr.trim(),`No environment variables set (on preview deployment ${candidate.name})`);
  const originalLog=readFileSync(join(dir,'backend-deploy.log'),'utf8');assert(originalLog.includes(candidate.deploymentUrl)&&originalLog.includes('Backend identifier differs from owned PR'));
  writeFileSync(join(dir,'before-recovery.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  receipt.recovery={at:new Date().toISOString(),expectedBackend:candidate,inventory:[functions,data,variables]};
  receipt.phase='backend-recovery-attempted';
 }else{receipt.phase='backend-attempted';receipt.backendAbsentBefore=true;receipt.attemptedAt=new Date().toISOString();}
 save(dir,receipt);
 const hook=`${quote(process.execPath)} ${quote(join(here,'bootstrap-env.mjs'))} ${quote(dir)}`;
 const args=['deploy','--preview-name',plan.name,'--typecheck','enable','--codegen','disable','--cmd',hook,'--cmd-url-env-var-name','PREVIEW_CONVEX_URL','--message',`I2 PR${plan.pr} ${plan.sha}`];
 const result=spawnSync(cli,args,{cwd:receipt.checkout,env,encoding:'utf8',maxBuffer:16*1024*1024});
 writeFileSync(join(dir,recovery?'backend-recovery.log':'backend-deploy.log'),safeLog((result.stdout||'')+(result.stderr||''),key),{flag:'wx'});
 assert.equal(result.status,0,'Backend deploy failed; preserve receipt and reconcile exact attempted preview');
 const after=load(dir).receipt;assertBackend(plan,after.backend);after.phase='backend-ready';save(dir,after);
 return {sha:plan.sha,backend:after.backend,phase:after.phase};
 });
}
if(isMain(import.meta.url)){
 try{assert(process.argv.length===3||(process.argv.length===6&&process.argv[3]==='--recover'));const recovery=process.argv[3]?{name:process.argv[4],id:Number(process.argv[5])}:undefined;console.log(JSON.stringify(await backend(process.argv[2],recovery),null,2));}catch(e){console.error(e.message);process.exitCode=1;}
}
