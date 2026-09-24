import { Worker, NativeConnection, Runtime, DefaultLogger } from '@temporalio/worker';
import { readFileSync, appendFileSync } from 'node:fs';
import { ConvexHttpClient } from 'convex/browser';
import { anyApi } from 'convex/server';
import { ApplicationFailure } from '@temporalio/common';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const [role,dir,queue,mode]=process.argv.slice(2);
Runtime.install({logger:new DefaultLogger('ERROR')});
const connection=await NativeConnection.connect({address:process.env.TEMPORAL_ADDRESS??'127.0.0.1:3563'});
const event=(type,data={})=>appendFileSync(`${dir}/events.jsonl`,JSON.stringify({at:Date.now(),type,...data})+'\n');
const post={id:'post-synthetic',organizationId:'org-synthetic',state:'QUEUE',settings:'{}',publishDate:new Date().toISOString(),integration:{id:'integration-synthetic',organizationId:'org-synthetic',providerIdentifier:'synthetic',name:'fake-provider',refreshNeeded:false,disabled:false}};
const activities=role==='main'?{
 getPost:async()=>post,getPostsList:async()=>[post],
 changeState:async(id,state)=>event('state',{state}),
 updatePost:async()=>event('published'),inAppNotification:async(org,title)=>event('notification',{unconfirmed:title.includes("couldn't confirm")}),
 sendWebhooks:async()=>{},internalPlugs:async()=>[],globalPlugs:async()=>[],
}: {
 postSocialPending:async()=>require(`${dir}/heartbeat.cjs`).withHeartbeat(async()=>{
   if(mode.startsWith('permit-')){
     const proceed=new Promise(resolve=>process.once('message',resolve));process.send?.({type:'before-provider'});await proceed;
     if(mode==='permit-patched'){
       const args=JSON.parse(readFileSync(`${dir}/authority.json`));const client=new ConvexHttpClient('http://127.0.0.1:3560',{logger:false});
       try{const permit=await client.mutation(anyApi.harness.permit,args);const {expires,maxUnits,maxRecipients,...consume}=permit;await client.mutation(anyApi.harness.consume,{token:args.token,...consume});}
       catch{event('finalPermitDenied');throw ApplicationFailure.nonRetryable('Authority revoked before provider effect','bad_body');}
     }
   }
   event('providerAccepted');process.send?.({type:'accepted'});
   if(mode==='crash')return new Promise(()=>{});
   return [{id:post.id,postId:'synthetic-receipt',releaseURL:'https://example.invalid/synthetic',status:'success'}];
 }),internalPlugs:async()=>[],globalPlugs:async()=>[],
};
const worker=await Worker.create({connection,namespace:'default',taskQueue:queue,activities,...(role==='main'?{workflowsPath:`${dir}/workflow.cjs`}:{}),maxHeartbeatThrottleInterval:'15s'});
process.send?.({type:'ready'});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>worker.shutdown());
await worker.run();await connection.close();
