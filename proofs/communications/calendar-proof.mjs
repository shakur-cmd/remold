// Owner-driven one-event fixture; not an H0 calendar adapter or a general event writer.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {open} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {OAuth2Client} from 'google-auth-library';
import assert from 'node:assert/strict';
import {runCalendar,INITIAL,MOVED,OWNER} from './calendar-proof-core.mjs';
import {CALENDAR_SCOPE} from './oauth.mjs';
const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'../..'),privateDir=join(here,'.private');
const planPath=join(privateDir,'calendar-plan.json'),attemptPath=join(privateDir,'calendar-attempt.jsonl');
const hash=value=>createHash('sha256').update(value).digest('hex'),json=path=>JSON.parse(readFileSync(path));
if(process.argv[2]==='--prepare'){
 const plan={calendar:'primary',owner:OWNER,maxCreatedEvents:1,sendUpdates:'none',id:'remold'+randomUUID().replaceAll('-',''),summary:'Remold integration TEST',initial:INITIAL,moved:MOVED,attendees:[]};
 writeFileSync(planPath,JSON.stringify(plan,null,2)+'\n',{mode:0o600,flag:'wx'});console.log(JSON.stringify({planSha256:hash(readFileSync(planPath)),providerCalls:0}));process.exit(0);
}
if(process.argv[2]!=='--run-reviewed'||process.argv.length!==4)throw new Error('REVIEWED_CALENDAR_PLAN_REQUIRED');
assert.equal(hash(readFileSync(planPath)),process.argv[3]);assert.equal(existsSync(attemptPath),false,'Existing attempt: only exact-ID read reconciliation is permitted; never insert again');
const plan=json(planPath),ready=json(join(here,'evidence/oauth-ready.json')),connection=json(join(ready.privateDirectory,'mailbox-A.json'));
assert.equal(connection.email,OWNER);assert.equal(connection.calendarAuthorized,true);assert.ok(connection.tokens.scope.split(' ').includes(CALENDAR_SCOPE));
const env=Object.fromEntries(readFileSync(join(root,'.env.remold-sandbox.local'),'utf8').split(/\r?\n/).filter(s=>/^GOOGLE_(CLIENT_ID|CLIENT_SECRET)=/.test(s)).map(s=>{const i=s.indexOf('=');return[s.slice(0,i),s.slice(i+1).replace(/^(["'])(.*)\1$/,'$2')]}));
const auth=new OAuth2Client(env.GOOGLE_CLIENT_ID,env.GOOGLE_CLIENT_SECRET);auth.setCredentials(connection.tokens);
const evidence={level:'LIVE owner-driven one-event Calendar fixture; no H0 calendar capability claimed',planSha256:process.argv[3],eventId:plan.id,calendar:'primary',owner:OWNER,steps:[],apiCalls:0};
const record=async(kind,data)=>{
 const file=await open(attemptPath,kind==='create-intent'?'wx':'a',0o600);
 try{await file.writeFile(JSON.stringify({kind,at:new Date().toISOString(),...data})+'\n');await file.sync();}finally{await file.close();}
 if(kind==='create-intent'){const dir=await open(privateDir,'r');try{await dir.sync();}finally{await dir.close();}}
 evidence.steps.push({kind,...data});writeFileSync(join(here,'evidence/calendar-live.json'),JSON.stringify(evidence,null,2)+'\n');
};
const request=async(method,path,body,headers={})=>{
 assert.ok(path==='/calendars/primary/events?sendUpdates=none'||path==='/calendars/primary/events/'+plan.id||path==='/calendars/primary/events/'+plan.id+'?sendUpdates=none');
 const token=(await auth.getAccessToken()).token;evidence.apiCalls++;
 const response=await fetch('https://www.googleapis.com/calendar/v3'+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
 const data=response.status===204?undefined:await response.json();return{status:response.status,body:data};
};
try{evidence.result=await runCalendar({plan,request,record});evidence.status='PASS';console.log('PASS one Calendar test event created, rescheduled and deleted; no guests.');}
catch(error){evidence.status='STOPPED_OR_UNKNOWN';evidence.errorType=error.name;evidence.errorCode=/^[A-Z_]+$/.test(error.message)?error.message:'CHECK_EXACT_TEST_EVENT';process.exitCode=1;console.error('Calendar fixture stopped. Preserve attempt ledger; inspect only its exact test event.');}
finally{writeFileSync(join(here,'evidence/calendar-live.json'),JSON.stringify(evidence,null,2)+'\n');}
