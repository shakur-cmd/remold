import {createHmac} from 'node:crypto';import http from 'node:http';
import {createReceiver} from '/Users/urkel/Documents/CodeMyVibe/Projects/remold/proofs/marketing/capture/receiver.mjs';
const key='c'.repeat(64),box=createReceiver({key,tenant:'a',database:':memory:'});await new Promise(r=>box.server.listen(0,'127.0.0.1',r));const port=box.server.address().port;
const sig=b=>createHmac('sha256',key).update(b).digest('base64');
// raw http so duplicate headers and raw bytes are sent exactly
const send=(body,headers)=>new Promise((res,rej)=>{const r=http.request({host:'127.0.0.1',port,method:'POST',path:'/callback',headers},x=>{x.resume();x.on('end',()=>res(x.statusCode));});r.on('error',rej);r.end(body);});
const out={};
let b=Buffer.from('[1,2]');out.jsonArray=await send(b,{'Content-Type':'application/json','Webhook-Signature':sig(b)});
b=Buffer.from('{"x":1}');out.duplicateSignatureHeaders=await send(b,[['Content-Type','application/json'],['Webhook-Signature',sig(b)],['Webhook-Signature',sig(b)]].flat());
b=Buffer.from([0x7b,0x22,0x78,0x22,0x3a,0x22,0xff,0x22,0x7d]);out.invalidUtf8=await send(b,{'Content-Type':'application/json','Webhook-Signature':sig(b)});
b=Buffer.from('{"fresh":1}');out.freshBodyForeignOrigin=await send(b,{'Content-Type':'application/json','Webhook-Signature':sig(b),'X-Origin-Base-URL':'https://foreign.invalid'});
out.contentTypeWithCharset=await send(b,{'Content-Type':'application/json; charset=utf-8','Webhook-Signature':sig(b)});
out.rows=box.database.prepare('SELECT tenant,body FROM receipts').all().map(r=>({...r}));
console.log(JSON.stringify(out));box.server.close();
