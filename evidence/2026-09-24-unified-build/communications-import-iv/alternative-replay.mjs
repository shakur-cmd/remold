import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, cpSync, mkdirSync, mkdtempSync, symlinkSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import net from 'node:net';
import { ConvexHttpClient } from 'convex/browser';
import { anyApi } from 'convex/server';
const here=fileURLToPath(new URL('../../../proofs/communications/',import.meta.url)),root=resolve(here,'../..');
const label=process.argv[2]??`builder-${Date.now()}`;
assert.match(label,/^[a-zA-Z0-9_-]+$/);
const output=join(dirname(fileURLToPath(import.meta.url)),'runs',label);mkdirSync(output,{recursive:true});
writeFileSync(join(output,'started.json'),JSON.stringify({at:new Date().toISOString(),level:'SERVICE local Convex; synthetic provider pages only'}),{flag:'wx'});
const hash=b=>createHash('sha256').update(b).digest('hex');
const baseline=JSON.parse(readFileSync(join(here,'evidence/import/baseline/source-manifest.json'),'utf8'));
const protectedHashes=JSON.parse(readFileSync(join(here,'evidence/import/private-hashes-before.json'),'utf8'));
const protectedAtStart=Object.fromEntries(Object.entries(protectedHashes).map(([path,digest])=>{const present=existsSync(join(here,path));if(present)assert.equal(hash(readFileSync(join(here,path))),digest,path);return [path,present?digest:null];}));
const beforeRootEnv=existsSync(join(root,'.env.local'))?hash(readFileSync(join(root,'.env.local'))):null;
function checkProtected(){for(const [path,digest] of Object.entries(baseline.files))assert.equal(hash(readFileSync(join(here,path))),digest,path);for(const [path,digest] of Object.entries(protectedAtStart))assert.equal(existsSync(join(here,path))?hash(readFileSync(join(here,path))):null,digest,path);assert.equal(existsSync(join(root,'.env.local'))?hash(readFileSync(join(root,'.env.local'))):null,beforeRootEnv);}
checkProtected();
const scratch=mkdtempSync(join(tmpdir(),'remold-mail-import-'));
cpSync(join(here,'import-local'),scratch,{recursive:true});symlinkSync(join(here,'node_modules'),join(scratch,'node_modules'),'dir');
const cli=join(here,'node_modules/convex/bin/main.js');
// Allowlist inherited environment. Never load project/provider credentials into the child.
const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,CI:'1',CONVEX_AGENT_MODE:'anonymous',CONVEX_DISABLE_METRICS:'1'};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const portFree=port=>new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(port,'127.0.0.1',()=>s.close(resolve));});
let backend, logs='',starts=0;const lifecycle=[],results=[];
async function start(){
  await portFree(3560);await portFree(3561);
  let current='';backend=spawn(process.execPath,[cli,'dev','--typecheck','disable','--tail-logs','disable','--local-cloud-port','3560','--local-site-port','3561'],{cwd:scratch,env,detached:true,stdio:['ignore','pipe','pipe']});
  const record={start:++starts,pid:backend.pid,at:new Date().toISOString()};lifecycle.push(record);
  for(const stream of [backend.stdout,backend.stderr])stream.on('data',b=>{current+=b;logs+=b});
  const deadline=Date.now()+180000;
  while(!current.includes('Convex functions ready')){if(backend.exitCode!==null||backend.signalCode!==null||Date.now()>deadline)throw new Error('BACKEND_NOT_READY');await delay(100);}
  assert.match(readFileSync(join(scratch,'.env.local'),'utf8'),/^CONVEX_URL=http:\/\/127\.0\.0\.1:3560$/m);
  record.ready=true;
}
async function stop(signal='SIGTERM'){
  if(!backend)return;const child=backend;backend=null;
  try{process.kill(-child.pid,signal);}catch(e){if(e.code!=='ESRCH')throw e;}
  for(let i=0;i<100;i++){try{await portFree(3560);await portFree(3561);break;}catch{if(i===99)throw new Error('BACKEND_DID_NOT_STOP');await delay(100);}}
  lifecycle.at(-1).stopSignal=signal;
}
let client;
const connect=()=>{client=new ConvexHttpClient('http://127.0.0.1:3560',{logger:false});};
const call=(name,args)=>client.mutation(anyApi.importer[name],args),snap=mailbox=>client.query(anyApi.importer.snapshot,{mailbox});
const item=(id,from='known@example.invalid')=>({id,from,text:'Synthetic text '+id});
try{
  await start();connect();const mailbox=await call('seed',{label:randomUUID()});
  const initial={mailbox,from:'100',traversal:'initial',page:0,items:[item('known')],end:true,checkpoint:'200'};
  assert.equal(await call('page',initial),'committed');
  assert.equal(await call('page',initial),'duplicate');
  const completed=await snap(mailbox);assert.equal(completed.cursor,'200');assert.equal(completed.messages.length,1);
  await stop('SIGKILL');await start();connect();
  assert.deepEqual(await snap(mailbox),completed);
  results.push({name:'Completed cursor and known messages survive actual backend SIGKILL/restart',before:completed,after:await snap(mailbox)});
  const first={mailbox,from:'200',traversal:'partial',page:0,items:[item('known'),item('new'),item('unmatched','nobody@example.invalid')],end:false,checkpoint:'300'};
  assert.equal(await call('page',first),'staged');assert.equal(await call('page',first),'duplicate');
  const staged=await snap(mailbox);assert.equal(staged.cursor,'200');assert.equal(staged.messages.length,1);assert.equal(staged.pending.pages,1);
  await assert.rejects(call('page',{...first,page:1,end:true,items:[item('would-insert'),{...item('known'),text:'changed'}]}),/MESSAGE_INTEGRITY/);
  assert.deepEqual(await snap(mailbox),staged);
  await assert.rejects(call('page',{...first,page:2}),/PAGE_GAP/);
  await assert.rejects(call('page',{...first,items:[item('changed-replay')]}),/PAGE_REPLAY_CHANGED/);
  assert.deepEqual(await snap(mailbox),staged);
  results.push({name:'Failed partial page and changed/gapped replay cannot advance cursor or expose partial messages',snapshot:staged});
  // Worker/backend stop here after a committed staging page, before its traversal finishes.
  await stop('SIGKILL');await start();connect();assert.deepEqual(await snap(mailbox),staged);
  assert.equal(await call('page',first),'duplicate');
  const finish={...first,page:1,items:[item('ambiguous','ambiguous@example.invalid'),item('normalized',' KNOWN@EXAMPLE.INVALID ')],end:true};
  assert.equal(await call('page',finish),'committed');assert.equal(await call('page',finish),'duplicate');
  const imported=await snap(mailbox);assert.equal(imported.cursor,'300');assert.equal(imported.pending,null);assert.equal(imported.messages.length,5);
  assert.equal(imported.messages.find(m=>m.id==='unmatched').contact,null);assert.equal(imported.messages.find(m=>m.id==='ambiguous').contact,null);assert.equal(imported.messages.find(m=>m.id==='normalized').contact,'contact-1');
  results.push({name:'Restart resumes staged traversal; known IDs deduplicate; unknown and ambiguous addresses stay unmatched',before:staged,after:imported});
  const next={...initial,from:'300',traversal:'next',items:[item('known')],checkpoint:'400'};
  const concurrent=await Promise.all([call('page',next),call('page',next)]);assert.deepEqual(concurrent.sort(),['committed','duplicate']);
  assert.equal((await snap(mailbox)).messages.length,5);
  await assert.rejects(call('page',{...initial,traversal:'stale'}),/CURSOR_MISMATCH/);
  const second=await call('seed',{label:randomUUID()});await call('page',{...initial,mailbox:second,items:[item('known','nobody@example.invalid')]});assert.equal((await snap(second)).messages[0].contact,null);assert.equal((await snap(mailbox)).messages.find(m=>m.id==='known').contact,'contact-1');
  results.push({name:'Concurrent duplicate commits once; next traversal uses completed cursor; identities remain mailbox-local',concurrent,first:await snap(mailbox),second:await snap(second)});
  await call('page',{...first,from:'400',traversal:'expires',items:[item('not-visible')]});
  assert.equal(await call('historyExpired',{mailbox}),'paused');const paused=await snap(mailbox);assert.equal(paused.cursor,'400');assert.equal(paused.pending,null);assert.equal(paused.messages.length,5);
  await stop('SIGKILL');await start();connect();assert.deepEqual(await snap(mailbox),paused);
  await assert.rejects(call('page',{...next,from:'400',traversal:'no-broad-resync',checkpoint:'500'}),/HISTORY_EXPIRED_PAUSED/);assert.deepEqual(await snap(mailbox),paused);
  results.push({name:'History expiry durably pauses across restart, preserving completed cursor and refusing implicit resync',snapshot:paused});
  // Independent sequence: two staging pages, invalid empty finalization, restart, valid empty finalization.
  const alternative=await call('seed',{label:'iv-alternative-'+randomUUID()});
  const altBase={mailbox:alternative,from:'100',traversal:'iv-base',page:0,items:[item('iv-stored')],end:true,checkpoint:'opaque-base'};
  assert.equal(await call('page',altBase),'committed');
  const altPage={mailbox:alternative,from:'opaque-base',traversal:'iv-two-stages',page:0,items:[item('iv-stored'),item('iv-new')],end:false,checkpoint:'opaque-final'};
  assert.equal(await call('page',altPage),'staged');
  assert.equal(await call('page',{...altPage,page:1,items:[item('iv-new'),item('iv-other','other@example.invalid')]}),'staged');
  const altStaged=await snap(alternative);assert.equal(altStaged.cursor,'opaque-base');assert.equal(altStaged.messages.length,1);assert.equal(altStaged.pending.pages,2);assert.equal(altStaged.pending.count,3);
  const altFinal={...altPage,page:2,items:[],end:true};
  await assert.rejects(call('page',{...altFinal,checkpoint:'opaque-base'}),/CHECKPOINT_UNCHANGED/);
  assert.deepEqual(await snap(alternative),altStaged);
  await stop('SIGKILL');await start();connect();assert.deepEqual(await snap(alternative),altStaged);
  assert.equal(await call('page',altFinal),'committed');
  assert.equal(await call('page',altPage),'duplicate');assert.equal(await call('page',altFinal),'duplicate');
  const altCommitted=await snap(alternative);assert.equal(altCommitted.cursor,'opaque-final');assert.equal(altCommitted.pending,null);assert.equal(altCommitted.messages.length,3);assert.equal(altCommitted.messages.find(v=>v.id==='iv-other').contact,null);
  await assert.rejects(call('page',{...altFinal,checkpoint:'changed-token'}),/PAGE_REPLAY_CHANGED/);
  assert.deepEqual(await snap(alternative),altCommitted);
  results.push({name:'Independent two staged pages survive failed empty finalization and SIGKILL; empty final page commits once',before:altStaged,after:altCommitted});
  checkProtected();
  writeFileSync(join(output,'result.json'),JSON.stringify({pass:true,level:'SERVICE local Convex; SIM message pages/contacts',results,lifecycle,scratch,providerCalls:0,mailSends:0,calendarWrites:0,privateFilesUnchanged:true,protectedFilesPresent:Object.values(protectedAtStart).filter(Boolean).length,protectedFilesAbsent:Object.values(protectedAtStart).filter(v=>v===null).length,rootEnvironmentUnchanged:true},null,2)+'\n');
  console.log('PASS '+results.length+' durable import groups; 4 actual SIGKILL/restarts; no provider calls');
}catch(error){writeFileSync(join(output,'failure.json'),JSON.stringify({error:String(error),results,lifecycle,scratch},null,2));console.error(error);process.exitCode=1;}
finally{await stop();writeFileSync(join(output,'backend.log'),logs);checkProtected();}
