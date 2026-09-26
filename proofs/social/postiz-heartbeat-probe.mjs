// Runs the pinned upstream helper with a synthetic Temporal context and clock.
// It proves the pre-heartbeat execution window, not a real Temporal duplicate.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const here=dirname(fileURLToPath(import.meta.url)),require=createRequire(import.meta.url);
const ts=require('typescript');
const checkout=JSON.parse(readFileSync(join(here,'evidence/source-checkouts.json'),'utf8')).postiz;
const path='libraries/nestjs-libraries/src/temporal/temporal.heartbeat.ts';
const source=readFileSync(join(checkout.path,path),'utf8');
const heartbeats=[],timers=[];let providerAcceptances=0;
const context={info:{activityType:'postSocialPending'},heartbeat:details=>heartbeats.push(details)};
const module={exports:{}};
vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
  module,exports:module.exports,require:name=>{assert.equal(name,'@temporalio/activity');return{Context:{current:()=>context}}},
  setInterval:(fn,ms)=>{timers.push({fn,ms});return 1},clearInterval:()=>{},console,
});
module.exports.withHeartbeat(async()=>{providerAcceptances++;return new Promise(()=>{});});
assert.equal(providerAcceptances,1);assert.equal(heartbeats.length,0);assert.equal(timers[0].ms,15000);
const beforeFirstTick={providerAcceptances,serverHeartbeatCalls:heartbeats.length,intervalMs:timers[0].ms};
timers[0].fn();assert.equal(heartbeats.length,1);
const result={level:'SIM exact upstream helper; synthetic context/timer/provider',sourceCommit:checkout.commit,path,sourceSha256:createHash('sha256').update(source).digest('hex'),beforeFirstTick,afterFirstTick:{serverHeartbeatCalls:heartbeats.length},finding:'Provider function executes before any heartbeat call. Worker death after acceptance before first heartbeat is not excluded by missing heartbeat details.',actualTemporalWorkerCrashTest:false,actualPublicPosts:0};
writeFileSync(join(here,'evidence/postiz-heartbeat-window.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
