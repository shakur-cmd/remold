import {isMain} from './state.mjs';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync,mkdirSync,renameSync,copyFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {scope,childEnvironment,assertBackend} from './policy.mjs';
import {load,save,hash,locked,verifyCI} from './state.mjs';
export async function build(directory,rebuild=false) {
 const {dir,receipt,plan}=load(directory);assertBackend(plan,receipt.backend);
 assert.equal(receipt.phase,rebuild?'frontend-ready':'backend-ready');
 if(!rebuild)assert(!existsSync(join(dir,'artifact')),'Artifact already exists; retain evidence');
 const ci=verifyCI(plan);
 const releasePath=join(receipt.checkout,'ops/release/release.mjs');
 const release=await import(pathToFileURL(releasePath));
 const notes={class:'ui-only',rollbackTarget:scope.sha};
 const changed=execFileSync('git',['diff','--name-only',scope.sha,plan.sha],{cwd:receipt.checkout,encoding:'utf8'}).trim().split('\n');
 const validated=release.validateReleaseNotes(notes,changed);
 const schemaSha=hash(readFileSync(join(receipt.checkout,'convex/schema.ts')));
 const oldSchema=hash(execFileSync('git',['show',`${scope.sha}:convex/schema.ts`],{cwd:receipt.checkout}));assert.equal(schemaSha,oldSchema);
 release.preflight({release:validated,schemaSha256:schemaSha},scope.sha,oldSchema);
 return locked(dir,()=>{
  if(rebuild){
   assert(receipt.cloudflare?.absentBefore===true,'Only an owned frontend may be rebuilt');
   release.verifyArtifact(join(dir,'artifact'),plan.sha,receipt.artifact.manifestSha256);
   const archive=join(dir,'before-callback');mkdirSync(archive);
   copyFileSync(join(dir,'receipt.json'),join(archive,'receipt.json'));
   receipt.phase='rebuild-attempted';save(dir,receipt);
   for(const name of ['artifact','frontend-build.log','frontend-deploy.log'])renameSync(join(dir,name),join(archive,name));
  }
  const command=['exec','vite','build','--outDir',join(dir,'artifact')];
  const publicConfig={VITE_CONVEX_URL:receipt.backend.deploymentUrl,VITE_WORKOS_CLIENT_ID:scope.clientId,VITE_WORKOS_REDIRECT_URI:plan.callback,VITE_AUTH_SESSION_MODE:'preview-local'};
  const env=childEnvironment(process.env,publicConfig);
  const result=spawnSync('pnpm',command,{cwd:receipt.checkout,env,encoding:'utf8'});
  writeFileSync(join(dir,'frontend-build.log'),result.stdout+result.stderr,{flag:'wx'});assert.equal(result.status,0,'Frontend rebuild failed');
  load(dir);
  writeFileSync(join(dir,'artifact/version.json'),JSON.stringify({sha:plan.sha})+'\n',{flag:'wx'});
  const digest=release.sealArtifact(join(dir,'artifact'),{sha:plan.sha,baseSha:scope.sha,release:validated,schemaSha256:schemaSha,checks:{ci,environmentRebuild:{command:['pnpm',...command],publicConfig,testsReranOnRecompiledBytes:false}}});
  release.verifyArtifact(join(dir,'artifact'),plan.sha,digest);
  receipt.artifact={manifestSha256:digest,sha:plan.sha,ci,configSha256:receipt.configSha256};receipt.phase='artifact-ready';save(dir,receipt);
  return receipt.artifact;
 });
}
if(isMain(import.meta.url)){
 try{assert(process.argv.length<=4&&[undefined,'--rebuild'].includes(process.argv[3]));console.log(JSON.stringify(await build(process.argv[2],process.argv[3]==='--rebuild'),null,2));}catch(e){console.error(e.message);process.exitCode=1;}
}
