// IV r2 check 5: what the host loopback forward 127.0.0.1:3547 exposes without credentials, and on which addresses.
import net from 'node:net';import os from 'node:os';import {writeFileSync} from 'node:fs';
const base='http://127.0.0.1:3547',rows=[];
const probe=async(method,path,body)=>{try{const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(5000)});const t=await r.text();rows.push({method,path,body:body?.path??null,status:r.status,response:t.slice(0,140)});}catch(e){rows.push({method,path,error:e.message});}};
await probe('GET','/version');
for(const p of ['/api/check_admin_key','/api/list_snapshot','/api/shapes2','/api/export/zip'])await probe('GET',p);
const bogus='e'.repeat(64);
await probe('POST','/api/query',{path:'capture:inventory',args:{key:bogus},format:'json'});
await probe('POST','/api/query',{path:'capture:pending',args:{key:bogus,limit:1},format:'json'});
await probe('POST','/api/mutation',{path:'capture:capture',args:{key:bogus,idempotencyKey:'a'.repeat(32),email:'x@e.io',firstname:''},format:'json'});
await probe('POST','/api/mutation',{path:'capture:registerKey',args:{keyHash:'a'.repeat(64),tenant:'a',role:'edge'},format:'json'});
await probe('POST','/api/query',{path:'_system/cli/tables:list',args:{},format:'json'});
await probe('POST','/api/deploy2/start_push',{});
// Text/plain cross-site style request (what a web page in a local browser could send without preflight).
try{const r=await fetch(base+'/api/query',{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify({path:'capture:inventory',args:{key:bogus},format:'json'})});rows.push({method:'POST text/plain',path:'/api/query',status:r.status,cors:r.headers.get('access-control-allow-origin'),response:(await r.text()).slice(0,140)});}catch(e){rows.push({error:e.message});}
const addrs=Object.values(os.networkInterfaces()).flat().filter(a=>a.family==='IPv4'&&!a.internal).map(a=>a.address);
const open=(h)=>new Promise(r=>{const s=net.connect(3547,h);s.setTimeout(1500,()=>{s.destroy();r(false);});s.on('connect',()=>{s.destroy();r(true);});s.on('error',()=>r(false));});
const reach={};for(const a of ['127.0.0.1',...addrs])reach[a]=await open(a);
writeFileSync(new URL('./b5-loopback.json',import.meta.url),JSON.stringify({capturedAt:new Date().toISOString(),rows,reachableOn:reach},null,1)+'\n');
console.log(JSON.stringify({rows:rows.map(r=>[r.method,r.path,r.body,r.status,(r.response||'').slice(0,60)]),reach}));
