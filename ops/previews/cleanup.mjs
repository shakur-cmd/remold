import {isMain} from './state.mjs';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {cleanupPlan,convexEnvironment,reconcileBackend,scope} from './policy.mjs';
import {api} from './backend.mjs';
import {load,save,locked} from './state.mjs';
import {cloudflareAuth,cfPreview} from './frontend.mjs';
const here=fileURLToPath(new URL('.',import.meta.url));
export async function cleanup(directory,wrangler,workosCurrentFile) {
 return await locked(resolve(directory),async()=>{
  const {dir,receipt,plan}=load(directory);
  const pr=JSON.parse(execFileSync('gh',['pr','view',String(plan.pr),'--json','state,headRefOid,baseRefName'],{encoding:'utf8'}));
  assert.equal(pr.state,'CLOSED','Close only the owned rehearsal PR after acceptance');assert.equal(pr.headRefOid,plan.sha);assert.equal(pr.baseRefName,'i2/preview-base-73b060d');
  const key=readFileSync(join(here,'.private/convex-preview-key'),'utf8').trim();convexEnvironment({},key);
  const current=await fetch(`https://api.convex.dev/v1/deployments/${receipt.backend.name}`,{headers:{Authorization:`Bearer ${key}`}});
  assert(current.ok||current.status===404,`Backend readback failed: ${current.status}`);
  const backend=current.status===404?null:reconcileBackend(plan,await current.json(),await api(`/projects/${scope.projectId}/list_deployments`,key));
  const token=cloudflareAuth(wrangler,dir),cloudflare=await cfPreview(plan,token);
  const workos=JSON.parse(readFileSync(workosCurrentFile,'utf8'));
  const actions=cleanupPlan(plan,receipt,backend,workos,cloudflare);
  writeFileSync(join(dir,'workos-cleanup-plan.json'),JSON.stringify(actions.workos,null,2)+'\n');
  receipt.phase='cleanup-attempted';save(dir,receipt);
  if(actions.cloudflare)await cfPreview(plan,token,'DELETE',actions.cloudflare.id);
  assert.equal(await cfPreview(plan,token),null,'Frontend preview still exists');
  if(actions.convex){const r=await fetch(`https://api.convex.dev/v1${actions.convex.path}`,{method:'POST',headers:{Authorization:`Bearer ${key}`}});assert(r.ok,`Backend delete failed: ${r.status}`);}
  const absent=await fetch(`https://api.convex.dev/v1/deployments/${receipt.backend.name}`,{headers:{Authorization:`Bearer ${key}`}});assert.equal(absent.status,404,'Backend absence unconfirmed');
  receipt.phase='hosting-deleted-workos-pending';save(dir,receipt);
  return {phase:receipt.phase,workosCleanupPlan:join(dir,'workos-cleanup-plan.json'),otherPreviewMustStillBeChecked:true};
 });
}
if(isMain(import.meta.url)){
 try{console.log(JSON.stringify(await cleanup(...process.argv.slice(2)),null,2));}catch(e){console.error(e.message);process.exitCode=1;}
}
