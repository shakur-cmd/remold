// One read of the exact completed fixture event; never lists events or writes Calendar.
import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../../../proofs/communications/package.json',import.meta.url));
const {OAuth2Client}=require('google-auth-library');
import assert from 'node:assert/strict';
const here=new URL('../../../proofs/communications/',import.meta.url),read=p=>JSON.parse(readFileSync(new URL(p,here)));
const result=read('evidence/calendar-live.json'),ready=read('evidence/oauth-ready.json');
assert.equal(result.status,'PASS');assert.equal(result.owner,'shakur@envoylogic.com');assert.equal(result.calendar,'primary');assert.match(result.eventId,/^remold[a-f0-9]{32}$/);
const connection=JSON.parse(readFileSync(ready.privateDirectory+'/mailbox-A.json'));
assert.equal(connection.email,result.owner);assert.equal(connection.calendarAuthorized,true);
const env=Object.fromEntries(readFileSync(new URL('../../.env.remold-sandbox.local',here),'utf8').split(/\r?\n/).filter(s=>/^GOOGLE_(CLIENT_ID|CLIENT_SECRET)=/.test(s)).map(s=>{const i=s.indexOf('=');return[s.slice(0,i),s.slice(i+1).replace(/^(["'])(.*)\1$/,'$2')]}));
const auth=new OAuth2Client(env.GOOGLE_CLIENT_ID,env.GOOGLE_CLIENT_SECRET);auth.setCredentials(connection.tokens);
try{
 const token=(await auth.getAccessToken()).token;
 const response=await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events/'+result.eventId,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(20000)});
 const body=await response.json();
 const deleted=response.status===404||response.status===410||(response.status===200&&body.id===result.eventId&&body.status==='cancelled');
 const evidence={reviewer:'h0_builder, independent reviewer; exact-event GET only',operator:'root executed reviewed LIVE lifecycle',eventId:result.eventId,method:'GET',calendar:'primary',httpStatus:response.status,deleted,tombstone:body.status==='cancelled',calendarWrites:0,mailWrites:0,at:new Date().toISOString(),status:deleted?'PASS':'FAIL'};
 writeFileSync(new URL('./calendar-get.json',import.meta.url),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence));assert.equal(deleted,true);
}catch(error){console.error('Exact event read failed: '+error.name);process.exitCode=1;}
