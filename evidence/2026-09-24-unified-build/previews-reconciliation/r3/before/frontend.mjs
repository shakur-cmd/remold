import {isMain} from './state.mjs';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {scope,childEnvironment} from './policy.mjs';
import {load,save,locked,verifyCI} from './state.mjs';
export function cloudflareAuth(wrangler,cwd) {
 const env=childEnvironment(process.env);
 const version=spawnSync(process.execPath,[wrangler,'--version'],{cwd,env,encoding:'utf8'});assert.equal(version.stdout.trim(),'4.138.0');
 const result=spawnSync(process.execPath,[wrangler,'auth','token','--json'],{cwd,env,encoding:'utf8'});assert.equal(result.status,0,'Cloudflare credential retrieval failed');
 const auth=JSON.parse(result.stdout);assert(typeof auth.token==='string'&&auth.token.length>0);return auth.token;
}
export async function cfPreview(plan,token,method='GET',id) {
 const path=`/accounts/${scope.accountId}/workers/workers/${scope.worker}/previews/${method==='DELETE'?encodeURIComponent(id):plan.name}`;
 if(method==='DELETE')assert(typeof id==='string'&&id.length>0,'Exact owned preview ID required');
 const r=await fetch(`https://api.cloudflare.com/client/v4${path}`,{method,headers:{Authorization:`Bearer ${token}`}});const data=await r.json();
 if(method==='GET'&&r.status===404&&data.errors?.some(e=>e.code===10007))return null;
 assert(r.ok&&data.success,`Cloudflare ${method} failed: ${r.status}`);
 if(method==='DELETE')return true;
 assert.equal(data.result.name,plan.name);assert(typeof data.result.id==='string');
 return {id:data.result.id,name:plan.name,worker:scope.worker,accountId:scope.accountId};
}
export async function frontend(directory,wrangler) {
 return await locked(resolve(directory),async()=>{
  const {dir,receipt,plan}=load(directory);assert.equal(receipt.phase,'artifact-ready');verifyCI(plan);
  const release=await import(pathToFileURL(join(receipt.checkout,'ops/release/release.mjs')));release.verifyArtifact(join(dir,'artifact'),plan.sha,receipt.artifact.manifestSha256);
  const token=cloudflareAuth(wrangler,dir);assert.equal(await cfPreview(plan,token),null,'Cloudflare preview already exists; refuse unowned update');
  receipt.phase='frontend-attempted';receipt.cloudflareAbsentBefore=true;save(dir,receipt);
  const args=[wrangler,'preview','--config',join(dir,'wrangler.json'),'--name',plan.name,'--worker-name',scope.worker,'--ignore-base-config','--message',`I2 PR${plan.pr} ${plan.sha}`,'--json'];
  const result=spawnSync(process.execPath,args,{cwd:dir,env:childEnvironment(process.env),encoding:'utf8',maxBuffer:16*1024*1024});
  writeFileSync(join(dir,'frontend-deploy.log'),(result.stdout+result.stderr).replaceAll(token,'[redacted]'),{flag:'wx'});
  // Capture ownership even on a partial deployment, before considering a retry.
  const current=await cfPreview(plan,token);
  let returned;try{returned=JSON.parse(result.stdout);}catch{}
  if(current&&returned?.preview_id===current.id){receipt.cloudflare={...current,absentBefore:true};save(dir,receipt);}
  else if(current){receipt.unresolvedCloudflare=current;save(dir,receipt);throw new Error('Created frontend identity not confirmed by CLI response; manual reconciliation required');}
  assert.equal(result.status,0,'Frontend deployment failed; reconcile recorded resource before retry');assert(current);
  const version=await fetch(plan.origin+'/version.json',{cache:'no-store'});assert(version.ok);assert.equal((await version.json()).sha,plan.sha);
  receipt.versionReadback={sha:plan.sha,url:plan.origin+'/version.json',checkedAt:new Date().toISOString()};receipt.phase='frontend-ready';save(dir,receipt);return receipt.versionReadback;
 });
}
if(isMain(import.meta.url)){
 try{console.log(JSON.stringify(await frontend(process.argv[2],process.argv[3]),null,2));}catch(e){console.error(e.message);process.exitCode=1;}
}
