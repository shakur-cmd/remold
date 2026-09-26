import http from 'node:http';
import {createHmac,timingSafeEqual,randomBytes} from 'node:crypto';
import {readFileSync,realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

// Public submissions never reach Mautic. Each one is stored by a tenant-bound Convex mutation and acknowledged only
// after that mutation commits; rawcapture/reconcile.mjs later feeds captures to Mautic through its API.
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const mediaType=value=>value.split(';',1)[0].trim().toLowerCase();
// Same deliberately narrow email rule as rawcapture/convex/capture.ts: no %, *, ', &, quoting or spaces.
const EMAIL=/^[A-Za-z0-9_+-]+(\.[A-Za-z0-9_+-]+)*@([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
export const validEmail=email=>email.length<=254&&EMAIL.test(email)&&email.indexOf('@')<=64;
export function formToken(config){return createHmac('sha256',config.key).update(JSON.stringify([config.host,config.form])).digest('hex');}
export function createPublicServer(config){
 assert.match(config.host,/^tenant-[ab]\.marketing-proof\.invalid$/);assert.match(config.key,/^[a-f0-9]{64}$/);assert.match(config.form.id,/^[a-z0-9-]{1,40}$/);
 assert.deepEqual(config.form.fields.map(f=>[f.name,f.type]),[['email','email'],['firstname','text']]);assert.match(config.capture.key,/^[a-f0-9]{64}$/);
 const origin=value=>{const url=new URL(value);assert.equal(url.protocol,'http:');assert.equal(url.username,'');assert.equal(url.password,'');assert.equal(url.pathname,'/');assert.equal(url.search,'');return url;};
 const upstream=origin(config.upstream),store=origin(config.capture.url);
 const formPath='/form/'+config.form.id,token=formToken(config),cap=8192,responseCap=1048576;
 const reply=(res,status,body,type='text/plain; charset=utf-8')=>{res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"});res.end(body);};
 function native(path){
  return new Promise((resolve,reject)=>{
   const req=http.request({hostname:upstream.hostname,port:upstream.port||80,path,method:'GET',headers:{DNT:'1','Sec-GPC':'1'}},res=>{let size=0;const chunks=[];res.on('data',chunk=>{size+=chunk.length;if(size>responseCap)res.destroy(Error('Native response too large'));else chunks.push(chunk);});res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,type:String(res.headers['content-type']??''),body:Buffer.concat(chunks)}));});
   req.setTimeout(10000,()=>req.destroy(Error('Native timeout')));req.on('error',reject);req.end();
  });
 }
 // Resolves 'stored' only when Convex reports the committed mutation, 'conflict' when the idempotency key was already
 // used for different values. Anything else rejects and the client is told nothing was confirmed.
 function capture(idempotencyKey,email,firstname){
  const body=JSON.stringify({path:'capture:capture',args:{key:config.capture.key,idempotencyKey,email,firstname},format:'json'});
  return new Promise((resolve,reject)=>{
   const req=http.request({hostname:store.hostname,port:store.port||80,path:'/api/mutation',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{let size=0;const chunks=[];res.on('data',chunk=>{size+=chunk.length;if(size>65536)res.destroy(Error('Capture response too large'));else chunks.push(chunk);});res.on('error',reject);res.on('end',()=>{try{const r=JSON.parse(Buffer.concat(chunks));if(r.status==='success'&&typeof r.value?.id==='string')resolve('stored');else if(r.status==='error'&&r.errorData?.code==='conflict')resolve('conflict');else reject(Error('Capture not confirmed'));}catch(e){reject(e);}});});
   req.setTimeout(10000,()=>req.destroy(Error('Capture timeout')));req.on('error',reject);req.end(body);
  });
 }
 return http.createServer(async(req,res)=>{
  try{
   const hosts=req.rawHeaders.filter((_,i)=>i%2===0).filter(h=>h.toLowerCase()==='host');
   if(hosts.length!==1||req.headers.host!==config.host)return reply(res,421,'Unknown site');
   if(Object.keys(req.headers).some(h=>h==='forwarded'||h.startsWith('x-forwarded-')||h.startsWith('x-original-')||h.startsWith('x-rewrite-')||h==='x-host'))return reply(res,400,'Unexpected routing header');
   if(req.url===formPath&&req.method==='GET'){
    const fields=config.form.fields.map(f=>`<label>${escape(f.label)} <input name="${f.name}" type="${f.type}" maxlength="${f.name==='email'?254:100}"${f.name==='email'?' required':''}></label>`).join('');
    return reply(res,200,`<!doctype html><html><head><meta charset="utf-8"><title>${escape(config.form.title)}</title></head><body><h1>${escape(config.form.title)}</h1><form method="post" action="${formPath}" enctype="application/x-www-form-urlencoded">${fields}<input type="hidden" name="t" value="${token}"><input type="hidden" name="n" value="${randomBytes(16).toString('hex')}"><button type="submit">Submit</button></form></body></html>`,'text/html; charset=utf-8');
   }
   if(req.url===formPath&&req.method==='POST'){
    if(req.headers['content-type']!=='application/x-www-form-urlencoded')return reply(res,415,'Unsupported form encoding');
    if(req.headers.origin&&req.headers.origin!=='http://'+config.host)return reply(res,403,'Wrong form origin');
    if(Number(req.headers['content-length']??0)>cap)return reply(res,413,'Form too large');
    let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>cap){reply(res,413,'Form too large');return;}chunks.push(chunk);}
    const raw=Buffer.concat(chunks);let decoded;try{decoded=new TextDecoder('utf-8',{fatal:true}).decode(raw);}catch{return reply(res,400,'Invalid form encoding');}
    try{decodeURIComponent(decoded.replace(/\+/g,' '));}catch{return reply(res,400,'Invalid form encoding');}
    const values=new URLSearchParams(decoded),keys=[...values.keys()];
    if(keys.length!==new Set(keys).size||keys.some(k=>!['email','firstname','t','n'].includes(k))||!values.has('email')||!values.has('t')||!/^[a-f0-9]{32}$/.test(values.get('n')??''))return reply(res,400,'Unexpected form fields');
    const supplied=values.get('t');if(!/^[a-f0-9]{64}$/.test(supplied)||!timingSafeEqual(Buffer.from(supplied,'hex'),Buffer.from(token,'hex')))return reply(res,403,'Wrong published form');
    const email=values.get('email'),firstname=values.get('firstname')??'';
    if(!validEmail(email)||firstname.length>100||/[\x00-\x1f\x7f]/.test(firstname))return reply(res,400,'Invalid form values');
    // The rendered nonce is the idempotency key: a client retry of the same page resends it and is stored once.
    let stored;try{stored=await capture(values.get('n'),email,firstname);}catch{return reply(res,502,'Submission could not be confirmed');}
    return stored==='stored'?reply(res,200,'Submission received'):reply(res,409,'Submission conflicts with an earlier one');
   }
   const route=config.routes.find(r=>r.path===req.url);
   if(!route||!['GET','HEAD'].includes(req.method))return reply(res,404,'Not found');
   const result=await native(route.nativePath);if(result.status!==200||mediaType(result.type)!==route.contentType)return reply(res,502,'Published content unavailable');
   return reply(res,200,req.method==='HEAD'?'':result.body,route.contentType);
  }catch{if(!res.headersSent)reply(res,502,'Published content unavailable');else res.destroy();}
 });
}
if(process.argv[1]&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url)){
 const config=JSON.parse(readFileSync('/public-config.json'));createPublicServer(config).listen(8080,'0.0.0.0');
}
