import http from 'node:http';
import {createHmac,timingSafeEqual} from 'node:crypto';
import {readFileSync,realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const mediaType=value=>value.split(';',1)[0].trim().toLowerCase();
// Server-owned tracking policy. Mautic's ContactTracker returns no contact when Blocked-Tracking is set, so a raw
// (unmapped) form captures a submission without matching, merging or creating any native contact.
export const TRACKING_POLICY='raw-capture/blocked-tracking-v1';
const NATIVE_PRIVACY={Cookie:'Blocked-Tracking=1',DNT:'1','Sec-GPC':'1'};
export function formToken(config){return createHmac('sha256',config.key).update(JSON.stringify([config.host,config.form])).digest('hex');}
export function createPublicServer(config){
 assert.match(config.host,/^tenant-[ab]\.marketing-proof\.invalid$/);assert.match(config.key,/^[a-f0-9]{64}$/);assert.ok(Number.isSafeInteger(config.form.id)&&config.form.id>0);
 assert.deepEqual(config.form.fields.map(f=>[f.name,f.type]),[['email','email'],['firstname','text']]);
 if(config.admission?.policy!==TRACKING_POLICY||config.admission.formId!==config.form.id)throw Error('Form not admitted under the server tracking policy; refusing to serve');
 const upstream=new URL(config.upstream);assert.equal(upstream.protocol,'http:');assert.equal(upstream.username,'');assert.equal(upstream.password,'');assert.equal(upstream.pathname,'/');assert.equal(upstream.search,'');
 const formPath='/form/'+config.form.id,token=formToken(config),cap=8192,responseCap=1048576;
 const reply=(res,status,body,type='text/plain; charset=utf-8')=>{res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"});res.end(body);};
 function native(path,method='GET',body=''){
  return new Promise((resolve,reject)=>{
   const req=http.request({hostname:upstream.hostname,port:upstream.port||80,path,method,headers:method==='POST'?{...NATIVE_PRIVACY,'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(body)}:{DNT:'1','Sec-GPC':'1'}},res=>{let size=0;const chunks=[];res.on('data',chunk=>{size+=chunk.length;if(size>responseCap)res.destroy(Error('Native response too large'));else chunks.push(chunk);});res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,type:String(res.headers['content-type']??''),body:Buffer.concat(chunks)}));});
   req.setTimeout(10000,()=>req.destroy(Error('Native timeout')));req.on('error',reject);req.end(body);
  });
 }
 // One native submission at a time: concurrent posts to one form deadlock in Mautic (S->X upgrade on the forms row
 // for submission_count) and are lost with a 500. A retry could duplicate an ambiguous commit, so serialize instead.
 let queue=Promise.resolve();
 const submitNative=body=>{const run=queue.then(()=>native('/form/submit?formId='+config.form.id+'&ajax=1','POST',body));queue=run.catch(()=>{});return run;};
 return http.createServer(async(req,res)=>{
  try{
   const hosts=req.rawHeaders.filter((_,i)=>i%2===0).filter(h=>h.toLowerCase()==='host');
   if(hosts.length!==1||req.headers.host!==config.host)return reply(res,421,'Unknown site');
   if(Object.keys(req.headers).some(h=>h==='forwarded'||h.startsWith('x-forwarded-')||h.startsWith('x-original-')||h.startsWith('x-rewrite-')||h==='x-host'))return reply(res,400,'Unexpected routing header');
   if(req.url===formPath&&req.method==='GET'){
    const fields=config.form.fields.map(f=>`<label>${escape(f.label)} <input name="${f.name}" type="${f.type}" maxlength="${f.name==='email'?254:100}"${f.name==='email'?' required':''}></label>`).join('');
    return reply(res,200,`<!doctype html><html><head><meta charset="utf-8"><title>${escape(config.form.title)}</title></head><body><h1>${escape(config.form.title)}</h1><form method="post" action="${formPath}" enctype="application/x-www-form-urlencoded">${fields}<input type="hidden" name="t" value="${token}"><button type="submit">Submit</button></form></body></html>`,'text/html; charset=utf-8');
   }
   if(req.url===formPath&&req.method==='POST'){
    if(req.headers['content-type']!=='application/x-www-form-urlencoded')return reply(res,415,'Unsupported form encoding');
    if(req.headers.origin&&req.headers.origin!=='http://'+config.host)return reply(res,403,'Wrong form origin');
    if(Number(req.headers['content-length']??0)>cap)return reply(res,413,'Form too large');
    let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>cap){reply(res,413,'Form too large');return;}chunks.push(chunk);}
    const raw=Buffer.concat(chunks);let decoded;try{decoded=new TextDecoder('utf-8',{fatal:true}).decode(raw);}catch{return reply(res,400,'Invalid form encoding');}
    try{decodeURIComponent(decoded.replace(/\+/g,' '));}catch{return reply(res,400,'Invalid form encoding');}
    const values=new URLSearchParams(decoded),keys=[...values.keys()];
    if(keys.length!==new Set(keys).size||keys.some(k=>!['email','firstname','t'].includes(k))||!values.has('email')||!values.has('t'))return reply(res,400,'Unexpected form fields');
    const supplied=values.get('t');if(!/^[a-f0-9]{64}$/.test(supplied)||!timingSafeEqual(Buffer.from(supplied,'hex'),Buffer.from(token,'hex')))return reply(res,403,'Wrong published form');
    const email=values.get('email'),firstname=values.get('firstname')??'';
    if(email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||firstname.length>100||/[\x00-\x1f\x7f]/.test(firstname))return reply(res,400,'Invalid form values');
    const body=new URLSearchParams({'mauticform[formId]':String(config.form.id),'mauticform[formName]':config.form.name,'mauticform[return]':'','mauticform[email]':email,'mauticform[firstname]':firstname});
    const result=await submitNative(body.toString());
    let accepted;try{accepted=JSON.parse(result.body);}catch{return reply(res,502,'Submission could not be confirmed');}
    if(result.status!==200||mediaType(result.type)!=='application/json'||accepted.success!==1||accepted.errorMessage||accepted.validationErrors)return reply(res,502,'Submission could not be confirmed');
    return reply(res,200,'Submission received');
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
