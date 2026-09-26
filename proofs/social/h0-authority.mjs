import {spawn,execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,cpSync,mkdtempSync,symlinkSync,existsSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {ConvexHttpClient} from 'convex/browser';
import {anyApi} from 'convex/server';
export async function authority(){
 const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'../..'),contract=join(root,'proofs/contract');
 const hash=b=>createHash('sha256').update(b).digest('hex');
 const manifest=JSON.parse(readFileSync(join(contract,'evidence/contract-hashes.json')));
 for(const [path,digest] of Object.entries(manifest.sources))assert.equal(hash(readFileSync(join(contract,path))),digest);
 const scratch=mkdtempSync(join(tmpdir(),'remold-social-h0-'));
 cpSync(join(contract,'convex'),join(scratch,'convex'),{recursive:true});writeFileSync(join(scratch,'convex.json'),'{}');writeFileSync(join(scratch,'package.json'),JSON.stringify({name:'social-h0-proof',type:'module',dependencies:{convex:'1.46.0'}}));symlinkSync(join(here,'node_modules'),join(scratch,'node_modules'),'dir');
 const cli=join(here,'node_modules/convex/bin/main.js'),env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,CI:'1',CONVEX_AGENT_MODE:'anonymous',CONVEX_DISABLE_METRICS:'1'};
 const rootEnv=()=>existsSync(join(root,'.env.local'))?hash(readFileSync(join(root,'.env.local'))):null,before=rootEnv();let logs='';
 const backend=spawn(process.execPath,[cli,'dev','--typecheck','disable','--tail-logs','disable','--local-cloud-port','3560','--local-site-port','3561'],{cwd:scratch,env,detached:true,stdio:['ignore','pipe','pipe']});backend.stdout.on('data',b=>logs+=b);backend.stderr.on('data',b=>logs+=b);
 const stop=()=>{writeFileSync(join(scratch,'backend.log'),logs);try{process.kill(-backend.pid,'SIGTERM')}catch{}assert.equal(rootEnv(),before)};
 try{
 const deadline=Date.now()+180000;while(!logs.includes('Convex functions ready')){if(backend.exitCode!==null||Date.now()>deadline)throw new Error('H0_NOT_READY');await new Promise(r=>setTimeout(r,200))}
 const client=new ConvexHttpClient('http://127.0.0.1:3560',{logger:false}),call=(name,args)=>client.mutation(anyApi.harness[name],args);
 const f=JSON.parse(execFileSync(process.execPath,[cli,'run','harness:seed',JSON.stringify({run:randomUUID(),tokens:Array.from({length:10},randomUUID)})],{cwd:scratch,env,encoding:'utf8',stdio:['ignore','pipe','pipe']}));
 await call('grant',{token:f.A.sessions.owner,target:f.A.actors.manager,capability:'marketing.send',scope:{kind:'bindings',bindings:[f.A.binding],maxAmountMinor:1000,currency:'USD',maxRecipients:1},mode:'direct',delegate:false,expires:Date.now()+180000});
 const id=await call('propose',{token:f.A.sessions.manager,logical:'social-final-hook',binding:f.A.binding,capability:'marketing.send',payload:{content:'synthetic social text',audience:['recipient'],audienceVersion:1,destination:'A',schedule:0,amountMinor:0,currency:'USD',workflowVersion:1},reservationUnits:1,maxSteps:1});
 const claim=await call('claim',{token:f.A.sessions.manager,id,worker:'social-provider'});
 return {manifest:manifest.manifestSha256,permit:{token:f.A.adapter,id,...claim,worker:'social-provider'},revoke:()=>call('revoke',{token:f.A.sessions.owner,target:f.A.actors.manager}),stop};
 }catch(error){stop();throw error;}
}
