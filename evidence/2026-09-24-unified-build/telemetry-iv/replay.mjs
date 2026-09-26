import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { withLocalCore } from '../../../ops/rehearsal/local-core.mjs';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const result=await withLocalCore(async({site,url,run,scratch,root})=>{
 const cli=join(root,'node_modules/convex/bin/main.js');
 const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,CONVEX_AGENT_MODE:'anonymous',CI:'1',CONVEX_DISABLE_METRICS:'1'};
 const setting=(key,value)=>{execFileSync(process.execPath,[cli,'env','set',key,value],{cwd:scratch,env,stdio:['ignore','pipe','pipe'],timeout:60_000});};
 const report=()=>run('telemetry:report',{minutes:60,asOfMinute:Math.floor(Date.now()/60_000)});
 const waitFor=async(check,label,timeout=30_000)=>{const deadline=Date.now()+timeout;while(!check()){assert.ok(Date.now()<deadline,`Timeout: ${label}`);await pause(150);} };
 const path=join(scratch,'convex/http.ts'),original=readFileSync(path,'utf8');
 const fixture=(delay,status)=>original.replace('async function dispatch(ctx: any, request: Request) {',`async function dispatch(ctx: any, request: Request) {
 if(new URL(request.url).pathname==="/api/v1/telemetry-fixture") {
  await new Promise(resolve=>setTimeout(resolve,${delay}));
  ${status===500?'throw new Error("Synthetic failure; scratch only");':'return json({synthetic:true});'}
 }
 `);
 const request=async()=>{const start=performance.now();const response=await fetch(site+'/api/v1/telemetry-fixture?private=must-not-persist',{headers:{authorization:'Bearer synthetic-secret-must-not-persist'}});return {status:response.status,body:await response.json(),clientMs:performance.now()-start};};
 async function install(delay,status){
  writeFileSync(path,fixture(delay,status));
  const deadline=Date.now()+30_000;
  while(true){const response=await request();if(response.status===status)return;assert.ok(Date.now()<deadline,'Fixture compilation');await pause(100);}
 }
 // Install before resetting metrics so compilation probes are excluded.
 await install(430,500);
 writeFileSync(join(scratch,'convex/telemetryFixture.ts'),`import {internalMutation,internalQuery} from "./_generated/server";
 export const reset=internalMutation({args:{},handler:async(ctx)=>{for(const table of ["opsMetrics","opsProbes"] as const)for(const row of await ctx.db.query(table).collect())await ctx.db.delete(row._id);}});
 export const snapshot=internalQuery({args:{},handler:async(ctx)=>({metrics:await ctx.db.query("opsMetrics").collect(),probes:await ctx.db.query("opsProbes").collect()})});\n`);
 await pause(1500);
 run('telemetryFixture:reset');
 const before=await request();assert.equal(before.status,500);assert.ok(before.clientMs>=420);
 await waitFor(()=>report().observed.count===1,'delayed failure metric');
 const delayed=report();assert.equal(delayed.observed.serverErrors,1);assert.ok(delayed.observed.meanMs>=420);assert.equal(delayed.observed.statusCounts['500'],1);
 await install(0,200);await pause(1000);run('telemetryFixture:reset');
 const after=await request();assert.equal(after.status,200);
 await waitFor(()=>report().observed.count===1,'corrected request metric');
 const corrected=report();assert.equal(corrected.observed.serverErrors,0);assert.ok(delayed.observed.meanMs>corrected.observed.meanMs+300);
 const snapshot=JSON.stringify(run('telemetryFixture:snapshot'));
 for(const forbidden of ['must-not-persist','private=','authorization','synthetic-secret','/telemetry-fixture'])assert.ok(!snapshot.includes(forbidden));
 const baselineCount=corrected.observed.count;
 const burst=await Promise.all(Array.from({length:73},()=>request()));
 assert.ok(burst.every(r=>r.status===200));
 await waitFor(()=>report().observed.count===baselineCount+73,'all seventy-three concurrent scheduled receipts',60_000);
 const burstReport=report();
 for(const [kind,fn,args] of [['query','telemetry:report',{minutes:1,asOfMinute:Math.floor(Date.now()/60_000)}],['mutation','telemetry:record',{minute:Math.floor(Date.now()/60_000),route:'rest',status:200,durationMs:1,release:'unknown'}]]){
  const response=await fetch(url+'/api/'+kind,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({path:fn,args,format:'json'})});
  const body=await response.json();assert.equal(body.status,'error');assert.match(body.errorMessage,/public function/);
 }
 // Force a real scheduler argument failure in copied source, then prove the
 // same HTTP response survives. The phase query confirms that code is loaded.
 const helperPath=join(scratch,'convex/telemetryHttp.ts'),helperSource=readFileSync(helperPath,'utf8');
 const fixturePath=join(scratch,'convex/telemetryFixture.ts');
 writeFileSync(helperPath,helperSource+'\nexport const proofPhase="healthy";\n');
 writeFileSync(fixturePath,readFileSync(fixturePath,'utf8')+`\nimport {proofPhase} from "./telemetryHttp";
 export const phase=internalQuery({args:{},handler:()=>proofPhase});
 export const expired=internalMutation({args:{},handler:async(ctx)=>ctx.db.insert("opsMetrics",{minute:Math.floor(Date.now()/60000)-66,route:"rest",status:"200",release:"unknown",count:1,serverErrors:0,clientErrors:0,sumMs:1,maxMs:1,buckets:[1,0,0,0,0,0,0,0,0,0,0]})});\n`);
 const phase=()=>{try{return run('telemetryFixture:phase');}catch{return null;}};
 await waitFor(()=>phase()==='healthy','phase query compiled');
 const healthyResponse=await request();
 await waitFor(()=>report().observed.count===baselineCount+74,'healthy receipt before scheduler failure');
 const beforeFailure=report().observed.count;
 writeFileSync(helperPath,helperSource.replace('ctx.scheduler.runAfter(0,','ctx.scheduler.runAfter(Number.NaN,')+'\nexport const proofPhase="failure";\n');
 await waitFor(()=>phase()==='failure','real scheduling failure loaded');
 const failureResponse=await request();await pause(700);
 assert.equal(failureResponse.status,healthyResponse.status);assert.deepEqual(failureResponse.body,healthyResponse.body);
 assert.equal(report().observed.count,beforeFailure);
 writeFileSync(helperPath,helperSource+'\nexport const proofPhase="healthy";\n');
 await waitFor(()=>phase()==='healthy','healthy scheduling restored');
 run('telemetryFixture:expired');assert.ok(report().purgeLagMinutes>=1);run('telemetry:purge');
 assert.equal(report().purgeLagMinutes,0);
 // Compare client-observed latency with and without scheduling in alternating blocks.
 const latencies={on:[],off:[]};
 for(const state of ['off','on','on','off']){
  setting('REMOLD_METRICS_OFF',state==='off'?'1':'0');
  for(let i=0;i<10;i++)latencies[state].push((await request()).clientMs);
 }
 const summary=values=>({n:values.length,meanMs:values.reduce((a,b)=>a+b,0)/values.length,maxMs:Math.max(...values),samplesMs:values});
 setting('REMOLD_METRICS_OFF','0');
 const secret=randomBytes(32).toString('hex');setting('REMOLD_METRICS_PROBE_SECRET',secret);
 run('telemetry:probe');
 await waitFor(()=>report().coverage.some(m=>m.state==='covered'),'authenticated self-fetch probe');
 const coverageBefore=report().coverage.filter(m=>m.state==='covered');
 const unauthorized=await fetch(site+'/api/v1/_probe');assert.equal(unauthorized.status,401);
 // Stop transport, then run the same authenticated canary. Its receipt persists,
 // while its scheduled span is deliberately absent. Use a fresh minute.
 setting('REMOLD_METRICS_OFF','1');
 const minuteBefore=Math.floor(Date.now()/60_000);
 while(Math.floor(Date.now()/60_000)===minuteBefore)await pause(300);
 const gapMinute=Math.floor(Date.now()/60_000);
 run('telemetry:probe');
 const offBefore=report().observed.count,disabled=await request();assert.equal(disabled.status,200);
 await pause(700);assert.equal(report().observed.count,offBefore);
 console.log('Transport disabled: waiting for real three-minute coverage grace to expire.');
 while(Math.floor(Date.now()/60_000)<gapMinute+3)await pause(500);
 const gap=report().coverage.find(m=>m.minute===gapMinute);assert.equal(gap.state,'transport-gap');
 setting('REMOLD_METRICS_OFF','0');
 run('telemetry:probe');
 await waitFor(()=>report().coverage.some(m=>m.minute===Math.floor(Date.now()/60_000)&&m.state==='covered'),'probe restored');
 const sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
 return {status:'PASS',level:'SERVICE disposable local Convex; synthetic HTTP fault injection',before:{httpStatus:before.status,clientMs:before.clientMs,metric:delayed.observed},after:{httpStatus:after.status,clientMs:after.clientMs,metric:corrected.observed},concurrent:{requests:73,successfulHttpResponses:73,recordedDelta:burstReport.observed.count-baselineCount},operatorReadAndWriteRefusedPublicly:true,noRequestContentPersisted:true,realSchedulerFailurePreservedResponse:true,expiredRowPurged:true,overhead:{enabled:summary(latencies.on),disabled:summary(latencies.off),note:'Observed local alternating blocks; excludes neither noise nor drift; no causal performance claim.'},probe:{coveredBefore:coverageBefore,gapMinute,gap,restored:true,unauthorizedStatus:401},release:'unknown: artifact SHA pinning not implemented',sourceHashes:{http:sha(join(root,'convex/http.ts')),telemetry:sha(join(root,'convex/telemetry.ts')),telemetryHttp:sha(join(root,'convex/telemetryHttp.ts'))},limitations:['No delivered alerts, hosted dashboard, provider traffic or production deployment.','Canary does not detect partial loss or crashes before response completion.','No true release before/after comparison while backend release is unknown.']};
},{cloudPort:3460,sitePort:3461});
writeFileSync(new URL('./service.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({status:result.status,beforeMs:result.before.metric.meanMs,afterMs:result.after.metric.meanMs,concurrent:result.concurrent,gap:result.probe.gap,scratch:result.scratch}));
