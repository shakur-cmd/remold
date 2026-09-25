import {isMain} from './state.mjs';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync,realpathSync} from 'node:fs';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {scope,candidateHeads,previewPlan,previewConfig} from './policy.mjs';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export function prepare(checkout,pr,output) {
  checkout=realpathSync(checkout);output=resolve(output);
  const git=(...args)=>execFileSync('git',args,{cwd:checkout,encoding:'utf8'}).trim();
  const sha=candidateHeads[pr];assert(sha,'Only owned draft PR3/PR4 may be prepared');
  assert.equal(git('rev-parse','HEAD'),sha,'Wrong checkout commit');
  assert.equal(git('status','--porcelain','--untracked-files=all'),'','Checkout must be clean');
  assert(!readdirSync(checkout).some(f=>f.startsWith('.env')&&f!=='.env.example'),'Local environment files forbidden');
  const expected=`docs/unified-launch/preview-rehearsal-${pr===3?'a':'b'}.html`;
  assert.equal(git('diff','--name-only',scope.sha,sha),expected,'Application source differs from reviewed base');
  assert(!existsSync(output),'Output already exists');
  const rel=relative(checkout,realpathSync(resolve(output,'..')));
  assert(rel.startsWith('..')||isAbsolute(rel),'Use output outside checkout');
  const plan=previewPlan(pr,sha); const config=previewConfig(join(output,'artifact'));
  mkdirSync(output);writeFileSync(join(output,'plan.json'),JSON.stringify(plan,null,2)+'\n',{flag:'wx'});
  writeFileSync(join(output,'wrangler.json'),JSON.stringify(config,null,2)+'\n',{flag:'wx'});
  const receipt={phase:'prepared',plan,planSha256:digest(readFileSync(join(output,'plan.json'))),configSha256:digest(readFileSync(join(output,'wrangler.json'))),checkout,backend:null,cloudflare:null,workosOwned:null,artifact:null,hostedEffects:0};
  writeFileSync(join(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  return {pr,sha,output,planSha256:receipt.planSha256,configSha256:receipt.configSha256,hostedEffects:0};
}
if(isMain(import.meta.url)){
 try{const [checkout,pr,out]=process.argv.slice(2);console.log(JSON.stringify(prepare(checkout,Number(pr),out),null,2));}
 catch(error){console.error(error.message);process.exitCode=1;}
}
