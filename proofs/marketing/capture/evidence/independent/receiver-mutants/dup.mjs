import {createHmac} from 'node:crypto';import net from 'node:net';
const [,,mod]=process.argv;const {createReceiver}=await import(mod);
const key='c'.repeat(64),box=createReceiver({key,tenant:'a',database:':memory:'});await new Promise(r=>box.server.listen(0,'127.0.0.1',r));
const body='{"x":1}',s=createHmac('sha256',key).update(body).digest('base64');
const raw=`POST /callback HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nWebhook-Signature: ${s}\r\nWebhook-Signature: ${s}\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`;
const res=await new Promise(r=>{let d='';const c=net.connect(box.server.address().port,'127.0.0.1',()=>c.end(raw));c.on('data',x=>d+=x);c.on('close',()=>r(d));});
console.log(JSON.stringify({status:res.split(' ')[1],body:res.split('\r\n\r\n')[1],rows:box.database.prepare('SELECT count(*) n FROM receipts').get().n}));box.server.close();
