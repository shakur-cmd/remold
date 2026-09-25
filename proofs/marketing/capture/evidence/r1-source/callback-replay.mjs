import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHmac} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {context,prefix,directory,docker} from '../runtime.mjs';
import {receipts} from './callback-fixture.mjs';
const label=process.argv[2]??'root';assert.match(label,/^[a-zA-Z0-9_-]+$/);const output=directory+'capture/evidence/callback-replay-'+label+'.json';assert.ok(!existsSync(output));
const keys=Object.fromEntries(['a','b'].map(t=>[t,JSON.parse(readFileSync(directory+'private/callbacks/'+t+'.json')).key]));
function send(tenant,body,key,headers={}){
 const signature=createHmac('sha256',key).update(body).digest('base64');
 const script="let s='';for await(const c of process.stdin)s+=c;const a=JSON.parse(s);const r=await fetch('http://127.0.0.1:8080/callback',{method:'POST',headers:{'Content-Type':'application/json','Webhook-Signature':a.signature,...a.headers},body:a.body,signal:AbortSignal.timeout(5000)});console.log(r.status);";
 return Number(execFileSync('docker',['--context',context,'exec','-i',prefix+'-callback-'+tenant,'node','--input-type=module','-e',script],{input:JSON.stringify({body,signature,headers}),encoding:'utf8',stdio:['pipe','pipe','pipe']}));
}
const rows=[];
for(const tenant of ['a','b']){
 const before=receipts(tenant);assert.ok(before.length);const body=before[0].body,other=tenant==='a'?'b':'a';
 assert.equal(send(tenant,body,keys[other]),401);assert.deepEqual(receipts(tenant),before);
 assert.equal(send(tenant,body,keys[tenant],{'X-Origin-Base-URL':'http://foreign.invalid'}),200);assert.deepEqual(receipts(tenant),before);
 // A real process kill after acknowledgement must retain the stored native receipt.
 docker(['kill','--signal','KILL',prefix+'-callback-'+tenant]);docker(['start',prefix+'-callback-'+tenant]);assert.deepEqual(receipts(tenant),before);
 assert.equal(send(tenant,body,keys[tenant]),200);assert.deepEqual(receipts(tenant),before);
 rows.push({tenant,receipts:before.length,foreignKeyStatus:401,duplicateStatus:200,foreignOriginCannotRebind:true,actualSigkillRestartPreservedExactReceipts:true,duplicateAfterRestartAddsNothing:true});
}
writeFileSync(output,JSON.stringify({status:'PASS',level:'SERVICE actual saved native payloads and isolated receiver restarts',rows},null,2)+'\n',{flag:'wx'});console.log('PASS actual native receipt duplicate, foreign key/origin and SIGKILL/restart checks for both tenants.');
