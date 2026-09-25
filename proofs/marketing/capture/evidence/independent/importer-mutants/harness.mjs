// Isolated adversarial harness: synthetic rows only, own backend on 3720/3721, never touches native tenants or 3620/3621.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {cpSync,mkdirSync,symlinkSync,existsSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';import {homedir} from 'node:os';
import {createHash,randomBytes} from 'node:crypto';import net from 'node:net';
const R='/Users/urkel/Documents/CodeMyVibe/Projects/remold';
const {ConvexHttpClient}=await import(R+'/node_modules/convex/dist/esm/browser/index.js');
const {anyApi}=await import(R+'/node_modules/convex/dist/esm/server/index.js');
const [,,work,label,importerPath]=process.argv;
const scratch=join(work,label),home=join(scratch,'home');assert.ok(!existsSync(scratch));mkdirSync(home,{recursive:true,mode:0o700});
const version='precompiled-2026-09-21-0cf49cb',bin=join(home,'.cache/convex/binaries',version);mkdirSync(bin,{recursive:true});cpSync(join(homedir(),'.cache/convex/binaries',version,'convex-local-backend'),join(bin,'convex-local-backend'));
cpSync(R+'/proofs/marketing/capture/local',join(scratch,'app'),{recursive:true});symlinkSync(R+'/node_modules',join(scratch,'app/node_modules'),'dir');
if(importerPath)cpSync(importerPath,join(scratch,'app/convex/importer.ts'));
const env={PATH:process.env.PATH,HOME:home,TMPDIR:process.env.TMPDIR,CI:'1',CONVEX_AGENT_MODE:'anonymous',CONVEX_DISABLE_METRICS:'1'};
const free=p=>new Promise((res,rej)=>{const s=net.createServer();s.once('error',rej);s.listen(p,'127.0.0.1',()=>s.close(res));});
await free(3720);await free(3721);let logs='';
const child=spawn(process.execPath,[R+'/node_modules/convex/bin/main.js','dev','--local-cloud-port','3720','--local-site-port','3721','--local-backend-version',version,'--typecheck','disable','--tail-logs','disable'],{cwd:join(scratch,'app'),env,detached:true,stdio:['ignore','pipe','pipe']});
for(const s of [child.stdout,child.stderr])s.on('data',b=>logs+=b);
const t0=Date.now();while(!logs.includes('Convex functions ready')){if(child.exitCode!==null||Date.now()-t0>180000)throw Error('NOT_READY');await new Promise(r=>setTimeout(r,100));}
const client=new ConvexHttpClient('http://127.0.0.1:3720',{logger:false});
const call=(n,a)=>client.mutation(anyApi.importer[n],a),snap=(i,k)=>client.query(anyApi.importer.snapshot,{instance:i,key:k});
const row=(tenant,submissionId,contactId,results={email:'x'+submissionId+'@example.invalid'})=>{const r={tenant,formId:1,submissionId,contactId,dateSubmitted:'2026-09-25 00:00:00',results:Object.fromEntries(Object.entries(results).sort(([x],[y])=>x.localeCompare(y)))};return {...r,sha256:createHash('sha256').update(JSON.stringify(r)).digest('hex')};};
const cases=[];
async function expect(name,fn,pattern){try{const v=await fn();cases.push({name,expected:pattern?'refuse '+pattern:'accept',outcome:'accepted',value:JSON.stringify(v).slice(0,200),pass:!pattern});}catch(e){const m=String(e.message).match(/[A-Z_]{5,}/g)?.find(x=>!['SERVER','ERROR','REQUEST'].includes(x))??'error';cases.push({name,expected:pattern?'refuse '+pattern:'accept',outcome:'refused '+m,pass:!!pattern&&m===pattern});}}
try{
 const ka=randomBytes(32).toString('hex'),kb=randomBytes(32).toString('hex');
 const A=await call('seed',{tenant:'a',key:ka,formId:1}),B=await call('seed',{tenant:'b',key:kb,formId:1});
 const pa=(scan,after,upper,items,complete,next)=>call('page',{instance:A,key:ka,scan,after,upper,next:next??(complete?upper:items.at(-1).submissionId),complete,items});
 await expect('foreign key cannot read tenant A',()=>snap(A,kb),'INSTANCE_CREDENTIAL');
 await expect('foreign key cannot stage on tenant A',()=>call('page',{instance:A,key:kb,scan:'s1',after:0,upper:3,next:1,complete:false,items:[row('a',1,11)]}),'INSTANCE_CREDENTIAL');
 await expect('tenant B row cannot enter tenant A',()=>pa('s1',0,3,[row('b',1,11)],false),'CAPTURE_SCOPE');
 await expect('other form row refused',()=>pa('s1',0,3,[{...row('a',1,11),formId:2}],false),'CAPTURE_SCOPE');
 await expect('row above upper refused',()=>pa('s1',0,3,[row('a',4,11)],false),'CAPTURE_SCOPE');
 await expect('descending rows refused',()=>pa('s1',0,3,[row('a',2,11),row('a',1,11)],false,2),'CAPTURE_SCOPE');
 await expect('altered content with stale digest refused',()=>pa('s1',0,3,[{...row('a',1,11),results:{email:'y@example.invalid'}}],false),'CAPTURE_DIGEST');
 await expect('first page must start at cursor',()=>pa('s1',1,3,[row('a',2,11)],false),'PAGE_GAP');
 await expect('non-integer id refused',()=>pa('s1',0,3,[row('a',1.5,11)],false,1.5),'INTEGER_BOUND');
 await expect('empty incomplete page refused',()=>pa('s1',0,3,[],false,0),'PAGE_PROGRESS');
 await expect('next that skips rows refused',()=>pa('s1',0,3,[row('a',1,11)],false,2),'PAGE_PROGRESS');
 await expect('oversized field refused',()=>pa('s1',0,3,[row('a',1,11,{email:'x'.repeat(1001)})],false),'CAPTURE_BOUND');
 await expect('stage page 1',()=>pa('s1',0,3,[row('a',1,11)],false),null);
 await expect('same page replay is duplicate',()=>pa('s1',0,3,[row('a',1,11)],false),null);
 await expect('same page replay with different valid rows refused',()=>pa('s1',0,3,[row('a',1,12)],false),'REPLAY_CHANGED');
 await expect('second concurrent scan refused',()=>pa('s2',0,3,[row('a',1,11)],false),'TRAVERSAL_IN_PROGRESS');
 await expect('gap after page 1 refused',()=>pa('s1',2,3,[row('a',3,13)],true),'PAGE_GAP');
 await expect('finish before complete refused',()=>call('finish',{instance:A,key:ka,scan:'s1',observations:[]}),'TRAVERSAL_INCOMPLETE');
 await expect('stage final page',()=>pa('s1',1,3,[row('a',2,12),row('a',3,null)],true),null);
 await expect('finish missing one contact refused',()=>call('finish',{instance:A,key:ka,scan:'s1',observations:[{contactId:11,status:'present',suppressed:false}]}),'CONSENT_COVERAGE');
 await expect('finish with extra contact refused',()=>call('finish',{instance:A,key:ka,scan:'s1',observations:[11,12,99].map(c=>({contactId:c,status:'present',suppressed:false}))}),'CONSENT_COVERAGE');
 await expect('missing native contact must be suppressed',()=>call('finish',{instance:A,key:ka,scan:'s1',observations:[{contactId:11,status:'present',suppressed:false},{contactId:12,status:'missing',suppressed:false}]}),'MISSING_CONTACT_MUST_SUPPRESS');
 const obs=[{contactId:11,status:'present',suppressed:true},{contactId:12,status:'present',suppressed:false}];
 await expect('complete finish commits',()=>call('finish',{instance:A,key:ka,scan:'s1',observations:obs}),null);
 const committed=await snap(A,ka);
 await expect('repeat finish is duplicate',()=>call('finish',{instance:A,key:ka,scan:'s1',observations:obs.map(o=>({...o,suppressed:false}))}),null);
 await expect('old page replay after commit with changed rows refused',()=>pa('s1',0,3,[row('a',1,12)],false),'REPLAY_CHANGED');
 await expect('new scan below cursor refused',()=>pa('s3',0,5,[row('a',1,11)],false),'PAGE_GAP');
 const afterReplays=await snap(A,ka);assert.deepEqual(afterReplays,committed);cases.push({name:'replays after commit leave snapshot identical',pass:true});
 cases.push({name:'commit state',pass:committed.captures.length===3&&committed.events.length===5&&committed.cursor===3,detail:{captures:committed.captures.length,events:committed.events.length,cursor:committed.cursor,suppression:committed.suppression.map(s=>[s.data.contactId,s.data.suppressed])}});
 // Boundary probes (acknowledged limits, not claimed protections)
 await expect('stale unsuppressed observation accepted after suppressed (read/finalize race boundary)',async()=>{await pa('s4',3,3,[],true,3);return call('finish',{instance:A,key:ka,scan:'s4',observations:obs.map(o=>({...o,suppressed:false}))});},null);
 const k=await snap(A,ka);cases.push({name:'boundary: contact 11 now recorded unsuppressed by later-committed observation',pass:true,informational:true,detail:k.suppression.map(s=>[s.data.contactId,s.data.suppressed])});
 // Non-ASCII result keys: Node ICU localeCompare vs Convex runtime ordering
 await expect('non-ASCII field keys digest agrees across runtimes',async()=>{await pa('s5',3,4,[row('a',4,11,{'é':'1',e:'2',Z:'3',a:'4',_:'5','ß':'6'})],true);return call('finish',{instance:A,key:ka,scan:'s5',observations:obs});},null);
 // max100 wedge on tenant B
 const pb=(scan,after,upper,items,complete)=>call('page',{instance:B,key:kb,scan,after,upper,next:complete?upper:items.at(-1).submissionId,complete,items});
 for(let s=0;s<4;s++){const items=Array.from({length:25},(_,i)=>row('b',s*25+i+1,null));await pb('b'+s,s*25,(s+1)*25,items,true);await call('finish',{instance:B,key:kb,scan:'b'+s,observations:[]});}
 await expect('max100: capture 101 staged',()=>pb('b4',100,101,[row('b',101,null)],true),null);
 await expect('max100: capture 101 finish refused',()=>call('finish',{instance:B,key:kb,scan:'b4',observations:[]}),'CAPTURE_BOUND');
 await expect('max100: instance then wedged for any new scan',()=>pb('b5',100,101,[row('b',101,null)],true),'TRAVERSAL_IN_PROGRESS');
}finally{try{process.kill(-child.pid,'SIGTERM');}catch{}writeFileSync(join(scratch,'backend.log'),logs,{mode:0o600});}
console.log(JSON.stringify({label,importerSha256:createHash('sha256').update(readFileSync(join(scratch,'app/convex/importer.ts'))).digest('hex'),cases},null,1));
