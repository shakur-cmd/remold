import {spawn,execFileSync}from'node:child_process';
import {readFileSync,writeFileSync,existsSync,mkdirSync,symlinkSync}from'node:fs';
import {createHash}from'node:crypto';
import {fileURLToPath}from'node:url';
import assert from'node:assert/strict';
const cwd=fileURLToPath(new URL('.',import.meta.url)),root=fileURLToPath(new URL('../../',import.meta.url));
export async function withPayments(check){
 mkdirSync(cwd+'private',{recursive:true,mode:0o700});
 if(!existsSync(cwd+'node_modules'))symlinkSync(root+'node_modules',cwd+'node_modules','dir');
 const approved=JSON.parse(readFileSync(cwd+'evidence/h0-source.json','utf8'));
 for(const [source,target]of[['convex/contract.ts','convex/contract.ts'],['convex/harness.ts','convex/harness.ts'],['convex/schema.ts','convex/h0_schema.ts']])assert.equal(createHash('sha256').update(readFileSync(cwd+target)).digest('hex'),approved.copies[source],'H0 core changed');
 const rootEnv=existsSync(root+'.env.local')?createHash('sha256').update(readFileSync(root+'.env.local')).digest('hex'):null;
 const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,CONVEX_AGENT_MODE:'anonymous',CONVEX_DISABLE_METRICS:'1',CI:'1'};
 const cli=root+'node_modules/convex/bin/main.js';let log='';
 const backend=spawn(process.execPath,[cli,'dev','--local-cloud-port','3490','--local-site-port','3491','--typecheck','enable','--tail-logs','disable'],{cwd,env,detached:true,stdio:['ignore','pipe','pipe']});
 for(const stream of [backend.stdout,backend.stderr])stream.on('data',chunk=>log+=chunk);
 const run=(path,args={})=>{try{const text=execFileSync(process.execPath,[cli,'run',path,JSON.stringify(args)],{cwd,env,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:60_000});return text.trim()?JSON.parse(text):null;}catch{throw new Error('Local function refused: '+path);}};
 try{
  const deadline=Date.now()+180_000;
  while(!log.includes('Convex functions ready')){if(backend.exitCode!==null||Date.now()>deadline)throw new Error('Payment backend failed; private backend log retained');await new Promise(r=>setTimeout(r,200));}
  const localEnv=readFileSync(cwd+'.env.local','utf8');assert.match(localEnv,/^(?:VITE_)?CONVEX_URL=http:\/\/127\.0\.0\.1:3490$/m);
  return await check({run,url:'http://127.0.0.1:3490',site:'http://127.0.0.1:3491',cwd,root});
 }finally{
  writeFileSync(cwd+'private/backend.log',log,{mode:0o600});try{process.kill(-backend.pid,'SIGTERM');}catch{}
  const after=existsSync(root+'.env.local')?createHash('sha256').update(readFileSync(root+'.env.local')).digest('hex'):null;assert.equal(after,rootEnv,'Root environment changed');
 }
}
