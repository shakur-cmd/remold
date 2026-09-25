import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHmac} from 'node:crypto';
import {createReceiver} from './receiver.mjs';
const key='a'.repeat(64),foreign='b'.repeat(64);
const sign=(body,k=key)=>createHmac('sha256',k).update(body).digest('base64');
async function open(path){const box=createReceiver({key,tenant:'a',database:path});await new Promise(r=>box.server.listen(0,'127.0.0.1',r));return {...box,url:'http://127.0.0.1:'+box.server.address().port};}
async function close(box){await new Promise(r=>box.server.close(r));box.database.close();}
const send=(box,body,signature=sign(body),extra={})=>fetch(box.url+'/callback',{method:'POST',headers:{'Content-Type':'application/json','Webhook-Signature':signature,...extra},body});
test('verified receipt survives reopen, duplicate delivery adds no receipt, origin cannot change tenant',async()=>{
 const path=join(mkdtempSync(join(tmpdir(),'remold-callback-')),'receipts.sqlite'),body=JSON.stringify({'mautic.form_on_submit':[{submission:{id:1}}]});let box=await open(path);
 try{
  assert.equal((await send(box,body)).status,200);assert.equal((await send(box,body,sign(body),{'X-Origin-Base-URL':'https://foreign.invalid'})).status,200);
  let rows=box.database.prepare('SELECT tenant, body FROM receipts').all();assert.equal(rows.length,1);assert.equal(rows[0].tenant,'a');assert.equal(rows[0].body,body);
  await close(box);box=await open(path);assert.equal((await send(box,body)).status,200);assert.equal(box.database.prepare('SELECT count(*) AS n FROM receipts').get().n,1);
 }finally{await close(box);}
});
test('wrong tenant key, altered bytes, malformed JSON and oversized payload leave no receipt',async()=>{
 const box=await open(':memory:'),body='{"event":1}';try{
  assert.equal((await send(box,body,sign(body,foreign))).status,401);
  assert.equal((await send(box,body+' ',sign(body))).status,401);
  assert.equal((await send(box,'{')).status,400);
  assert.equal((await send(box,body,sign(body),{'Content-Type':'text/plain'})).status,415);
  assert.equal((await send(box,'x'.repeat(1048577))).status,413);
  assert.equal(box.database.prepare('SELECT count(*) AS n FROM receipts').get().n,0);
 }finally{await close(box);}
});
test('durable storage failure never receives a successful acknowledgement',async()=>{
 const box=await open(':memory:');try{box.database.exec('PRAGMA query_only = ON');assert.equal((await send(box,'{"event":1}')).status,503);}finally{await close(box);}
});
