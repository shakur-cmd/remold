import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {ConvexHttpClient} from 'convex/browser';
import {makeFunctionReference} from 'convex/server';
const client=new ConvexHttpClient('http://127.0.0.1:3500',{logger:false}),call=(n,a)=>client.mutation(makeFunctionReference(n),a),read=(n,a)=>client.query(makeFunctionReference(n),a);
const cli=(n,a)=>JSON.parse(execFileSync(process.execPath,['../../../node_modules/convex/bin/main.js','run',n,JSON.stringify(a)],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const f=cli('harness:seed',{run:randomUUID(),tokens:Array.from({length:10},randomUUID)});
const child=await call('runner:hire',{token:f.A.sessions.owner,name:'IV lost-result descendant',reportsTo:f.A.actors.manager,sessionToken:randomUUID()});
await call('harness:grant',{token:f.A.sessions.owner,target:f.A.actors.manager,capability:'agent.manage',scope:{kind:'agents',agents:[child.id]},mode:'direct',delegate:false,expires:Date.now()+60000});
const grant=await call('harness:grant',{token:f.A.sessions.owner,target:f.A.actors.manager,capability:'model.call',scope:{kind:'model',maxUnitsPerRun:2,maxSteps:1},mode:'direct',delegate:true,expires:Date.now()+60000});
await call('harness:grant',{token:f.A.sessions.manager,target:child.id,parent:grant,capability:'model.call',scope:{kind:'model',maxUnitsPerRun:1,maxSteps:1},mode:'direct',delegate:false,expires:Date.now()+50000});
const task=await call('runner:create',{token:f.A.sessions.owner,assignee:child.id,binding:f.A.binding,title:'IV accepted response lost then manager fired',dependsOn:[],maxAttempts:1,fault:'loseResponse'});
await call('runner:start',{token:f.A.sessions.owner,id:task});
let before;for(let i=0;i<80;i++){before=await read('runner:task',{token:f.A.sessions.owner,id:task});if(before.status==='unknown')break;await wait(100)}assert.equal(before.status,'unknown');
await call('runner:fire',{token:f.A.sessions.owner,target:f.A.actors.manager});
const after=await read('runner:task',{token:f.A.sessions.owner,id:task});assert.equal(after.status,'paused');
let recoveryError,reassignmentError;
try{await call('runner:recover',{token:f.A.sessions.owner,id:task})}catch(e){recoveryError=e.message.includes('unknown outcome required')?'unknown outcome required':'other';}
try{await call('runner:reassign',{token:f.A.sessions.owner,id:task,assignee:f.A.actors.child})}catch(e){reassignmentError=e.message.includes('resolve old outcome before reassignment')?'resolve old outcome before reassignment':'other';}
const op=await read('harness:operation',{token:f.A.sessions.owner,id:after.operation}),snapshot=cli('runner:inspect',{org:f.A.org});
const output={beforeTaskStatus:before.status,afterTaskStatus:after.status,operationState:op.state,providerEffects:snapshot.effects.length,recoveryError,reassignmentError,acceptedOutcomeRecoverable:!recoveryError};
writeFileSync('../../../evidence/2026-09-24-unified-build/native-iv/lost-then-fired.json',JSON.stringify(output,null,2)+'\n');console.log(JSON.stringify(output));
