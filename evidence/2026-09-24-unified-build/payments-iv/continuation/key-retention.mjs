import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {claimContinuation,CONTINUATION_ID,CUSTOMERS} from '../../../../proofs/payments/continuation.mjs';
const privateDirectory=mkdtempSync(join(tmpdir(),'remold-iv-continuation-'));
const options={privateDirectory,evidenceDirectory:fileURLToPath(new URL('../../../../proofs/payments/evidence/',import.meta.url)),sourceAggregate:'independent-loopback-only'};
const journal=claimContinuation(options);let attempts=0,keyMatchedBeforeDispatch=false;
const server=createServer((req)=>{
 attempts++;
 const row=readFileSync(journal.path,'utf8').trim().split('\n').map(JSON.parse).at(-1);
 assert.equal(row.kind,'write-attempt');
 assert.equal(row.idempotencyKey,req.headers['idempotency-key']);
 assert.equal(row.idempotencyKey,CONTINUATION_ID+'-email-A');
 keyMatchedBeforeDispatch=true;req.socket.destroy();
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
try{
 const raw={receipts:[],request:async(method,path,params,account,key)=>fetch('http://127.0.0.1:'+server.address().port+path,{method,headers:{'Idempotency-Key':key},body:new URLSearchParams(params)})};
 await assert.rejects(journal.wrap(raw).request('POST','/v1/customers/'+CUSTOMERS.A.customer,{email:'synthetic@remold.invalid'},CUSTOMERS.A.account,CONTINUATION_ID+'-email-A'));
 const rows=readFileSync(journal.path,'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(rows.at(-1).outcome,'unknown');
 assert.equal(rows.find(r=>r.kind==='write-attempt').idempotencyKey,CONTINUATION_ID+'-email-A');
 assert.throws(()=>claimContinuation(options),/EEXIST/);assert.equal(attempts,1);
 const evidence={status:'PASS',level:'SERVICE loopback HTTP/filesystem, no provider calls',keyMatchedBeforeDispatch,exactKeyRetainedAfterSocketLoss:true,unknownRecorded:true,restartRefused:true,attempts};
 writeFileSync(new URL('./key-retention.json',import.meta.url),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence));
}finally{await new Promise(r=>server.close(r));rmSync(privateDirectory,{recursive:true,force:true});}
