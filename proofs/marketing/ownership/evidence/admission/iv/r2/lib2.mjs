// IV round 2 helpers for the raw-capture edge (422e818). Local colima-remold-proof containers only; synthetic data.
import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import * as L from '../lib.mjs';
import {keys,query,mutation} from '../../../../../rawcapture/runtime.mjs';
import {formToken} from '../../../../../publishing/server.mjs';
export * from '../lib.mjs';
export {keys,query,mutation};
export const K=keys();
export const config=t=>JSON.parse(readFileSync(L.directory+'private/publishing/config-'+t+'.json'));
export const token=t=>formToken(config(t));
export const nonce=()=>[...crypto.getRandomValues(new Uint8Array(16))].map(b=>b.toString(16).padStart(2,'0')).join('');
export const body=(t,email,firstname,n,tok=token(t))=>new URLSearchParams({email,firstname,t:tok,n}).toString();
export const P=(t,b,extra='',path='/form/intake')=>L.post(t,path,b,'Origin: http://'+L.host(t)+'\r\n'+extra);
export const inventory=t=>query('capture:inventory',{key:K[t].reconciler});
export function mautic(t){
 const k=['formSubmissions','submissionCountSum','contacts','anonymousContacts','maxLeadId','dnc','campaignLeads','queuedEmails','emailStats'];
 const v=L.sql(t,'SELECT (SELECT COUNT(*) FROM form_submissions),(SELECT COALESCE(SUM(submission_count),0) FROM forms),(SELECT COUNT(*) FROM leads),(SELECT COUNT(*) FROM leads WHERE email IS NULL),(SELECT COALESCE(MAX(id),0) FROM leads),(SELECT COUNT(*) FROM lead_donotcontact),(SELECT COUNT(*) FROM campaign_leads),(SELECT COUNT(*) FROM messenger_messages),(SELECT COUNT(*) FROM email_stats)').split('\t').map(Number);
 return Object.fromEntries(k.map((x,i)=>[x,v[i]]));
}
export const withEmail=(t,email)=>L.sql(t,`SELECT id,COALESCE(firstname,'') FROM leads WHERE LOWER(email)=LOWER('${email.replace(/'/g,"''")}') ORDER BY id`).split('\n').filter(Boolean).map(l=>{const [id,firstname]=l.split('\t');return {id:Number(id),firstname};});
// Concurrent HTTP client inside a container. target is host:port as seen from that container.
export const burstScript=`let s='';for await(const c of process.stdin)s+=c;const a=JSON.parse(s);const http=await import('node:http');let first=0;
const call=(b,i)=>new Promise(resolve=>{const t0=Date.now();const req=http.request({hostname:a.hostname,port:a.port,path:'/form/intake',method:'POST',agent:false,headers:{Host:a.host,'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(b),Origin:'http://'+a.host}},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{if(!first++)process.stderr.write('FIRST\\n');resolve({i,status:res.statusCode,body:d,ms:Date.now()-t0});});res.on('error',e=>resolve({i,status:0,body:e.code||e.message}));});req.setTimeout(30000,()=>req.destroy(Error('timeout')));req.on('error',e=>resolve({i,status:0,body:e.code||e.message,ms:Date.now()-t0}));req.end(b);});
console.log(JSON.stringify(await Promise.all(a.bodies.map((b,i)=>call(b,i)))));`;
export function burst(container,input,onFirst){
 return new Promise((resolve,reject)=>{const p=spawn('docker',['--context',L.context,'exec','-i',container,'node','--input-type=module','-e',burstScript]);let o='',e='',fired=false;
  p.stdout.on('data',d=>o+=d);p.stderr.on('data',d=>{e+=d;if(!fired&&e.includes('FIRST')&&onFirst){fired=true;onFirst();}});
  p.on('close',c=>{try{resolve(JSON.parse(o.trim()));}catch{reject(Error('burst failed '+c+' '+e.slice(0,300)));}});p.stdin.end(JSON.stringify(input));});
}
export const save2=(name,data)=>writeFileSync(new URL('./'+name+'.json',import.meta.url),JSON.stringify({run:L.run,capturedAt:new Date().toISOString(),...data},null,1)+'\n',{flag:'wx'});
// D1 edit on the old native intake form and its revert (same shape as the round-1 attack).
export function d1Edit(t,formId){
 const f=L.ok(L.api(t,'/forms/'+formId)).form,fld=a=>f.fields.find(x=>x.alias===a);
 L.ok(L.api(t,'/forms/'+formId+'/edit','PATCH',{fields:[{id:fld('email').id,label:'Email',type:'email',alias:'email',mappedObject:'contact',mappedField:'email'},{id:fld('firstname').id,label:'First name',type:'text',alias:'firstname',mappedObject:'contact',mappedField:'firstname'},{id:f.fields.find(x=>x.type==='button').id,label:'Submit',type:'button',alias:'submit'}],actions:[{name:'IV r2 remove DNC',type:'lead.remove_do_not_contact',properties:{}}]}));
 const e=L.ok(L.api(t,'/forms/'+formId)).form;return {mapped:e.fields.filter(x=>x.mappedField).map(x=>x.alias),actions:Object.values(e.actions??{}).map(a=>a.type)};
}
export function d1Revert(t,formId){
 const f=L.ok(L.api(t,'/forms/'+formId)).form,ids=Object.values(f.actions??{}).map(a=>a.id);
 if(ids.length)L.api(t,'/forms/'+formId+'/actions/delete?'+ids.map(i=>'actions[]='+i).join('&'),'DELETE');
 L.api(t,'/forms/'+formId+'/edit','PATCH',{fields:f.fields.map(x=>({id:x.id,label:x.label,type:x.type,alias:x.alias,mappedObject:null,mappedField:null}))});
 const r=L.ok(L.api(t,'/forms/'+formId)).form;return {mapped:r.fields.filter(x=>x.mappedField).length,actions:Object.values(r.actions??{}).length};
}
