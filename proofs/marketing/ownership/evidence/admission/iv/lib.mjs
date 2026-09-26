// Independent verifier helpers. Local colima-remold-proof containers only; synthetic data; no mail/DNS/TLS/ports.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {docker,directory,prefix,context} from '../../../../runtime.mjs';
import {api} from '../../../../tenants/api.mjs';
export {api,docker,directory,prefix,context};
export const run=randomUUID().slice(0,8);
export const host=t=>'tenant-'+t+'.marketing-proof.invalid';
export const sql=(t,q)=>docker(['exec',prefix+'-db-'+t,'sh','-c','MYSQL_PWD="$MYSQL_PASSWORD" mysql -u "$MYSQL_USER" "$MYSQL_DATABASE" -NB -e "$1"','--',q]).trim();
export const ok=r=>{assert.ok(r.status>=200&&r.status<300,'Native API refused '+r.status+' '+JSON.stringify(r.data).slice(0,400));return r.data;};
export function counts(t){
 const keys=['contacts','anonymousContacts','maxLeadId','dnc','submissions','campaignLeads','campaignEventLog','pointActionLog','queuedEmails','emailStats'];
 const row=sql(t,'SELECT (SELECT COUNT(*) FROM leads),(SELECT COUNT(*) FROM leads WHERE email IS NULL),(SELECT COALESCE(MAX(id),0) FROM leads),(SELECT COUNT(*) FROM lead_donotcontact),(SELECT COUNT(*) FROM form_submissions),(SELECT COUNT(*) FROM campaign_leads),(SELECT COUNT(*) FROM campaign_lead_event_log),(SELECT COUNT(*) FROM point_lead_action_log),(SELECT COUNT(*) FROM messenger_messages),(SELECT COUNT(*) FROM email_stats)').split('\t').map(Number);
 return Object.fromEntries(keys.map((k,i)=>[k,row[i]]));
}
export const profile=(t,id)=>{const c=ok(api(t,'/contacts/'+id)).contact;return {id:c.id,firstname:c.fields.all.firstname,lastname:c.fields.all.lastname,email:c.fields.all.email,points:c.points,tags:(c.tags??[]).map(x=>x.tag),doNotContact:c.doNotContact.map(d=>({channel:d.channel,reason:d.reason}))};};
export function makeOwner(t,tag){
 const email='iv-own-'+run+'-'+tag+'@example.invalid';
 const c=ok(api(t,'/contacts/new','POST',{email,firstname:'IV owner '+tag,lastname:'Stable '+tag})).contact;
 ok(api(t,'/contacts/'+c.id+'/dnc/email/add','POST',{reason:3,comments:'IV admission proof'}));
 return {id:c.id,email};
}
export const rawForm=(name,over={})=>({name,formType:'standalone',isPublished:true,postAction:'return',postActionProperty:'IV intake received',fields:[{label:'Email',type:'email',alias:'email',isRequired:true,saveResult:true},{label:'First name',type:'text',alias:'firstname',saveResult:true},{label:'Submit',type:'button',alias:'submit'}],actions:[],...over});
export const submissionsFor=(t,formId,emailLike)=>sql(t,`SELECT s.id,COALESCE(s.lead_id,'null') FROM form_submissions s WHERE s.form_id=${Number(formId)} ORDER BY s.id`).split('\n').filter(Boolean).map(l=>{const [id,lead]=l.split('\t');return {id:Number(id),lead:lead==='null'?null:Number(lead)};});
export function resultsTable(t,formId){
 // Mautic stores form results in form_results_<id>_<alias>
 const table=sql(t,`SELECT table_name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name LIKE 'form_results_${Number(formId)}\\_%'`);return table||null;
}
// Run a node module script inside a container with JSON on stdin; returns parsed last stdout line.
export function inContainer(name,script,input){
 const out=execFileSync('docker',['--context',context,'exec','-i',name,'node','--input-type=module','-e',script],{input:JSON.stringify(input),encoding:'utf8',stdio:['pipe','pipe','pipe'],maxBuffer:64*1024*1024});
 return JSON.parse(out.trim().split('\n').pop());
}
// Raw HTTP/1.1 requests over a socket from inside the tenant's public edge container to the deployed edge on 8080.
export function rawRequests(t,requests,{port=8080,target='127.0.0.1',container=prefix+'-public-'+t}={}){
 const script=`let s='';for await(const c of process.stdin)s+=c;const a=JSON.parse(s);const net=await import('node:net');
const one=raw=>new Promise(resolve=>{const sock=net.connect(a.port,a.target);let buf='';sock.setTimeout(20000,()=>{sock.destroy();resolve({error:'timeout',raw:buf});});sock.on('data',d=>buf+=d);sock.on('error',e=>resolve({error:e.code||e.message,raw:buf}));sock.on('close',()=>resolve({raw:buf}));sock.write(raw,'latin1');});
const out=[];for(const r of a.requests){const x=await one(r);out.push({statuses:[...x.raw.matchAll(/^HTTP\\/1\\.[01] (\\d{3})/gm)].map(m=>Number(m[1])),bodies:x.raw.split('\\r\\n\\r\\n').slice(1).map(b=>b.slice(0,60)),error:x.error??null});}
console.log(JSON.stringify(out));`;
 return inContainer(container,script,{requests,port,target});
}
export async function edgeToken(t){const {formToken}=await import('../../../../publishing/server.mjs');return formToken(JSON.parse(readFileSync(directory+'private/publishing/config-'+t+'.json')));}
export const deployedFormId=t=>JSON.parse(readFileSync(directory+'private/publishing/config-'+t+'.json')).form.id;
export const formBody=(email,firstname,token)=>new URLSearchParams({email,firstname,t:token}).toString();
export const post=(t,path,body,extra='')=>`POST ${path} HTTP/1.1\r\nHost: ${host(t)}\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: ${Buffer.byteLength(body)}\r\n${extra}Connection: close\r\n\r\n${body}`;
// Start a copy of a server module in-process inside the tenant edge container (same image/network as the deployed
// edge), with a config for any form, then post rows concurrently. serverSource lets a mutant be exercised live.
export function probeEdge(t,{serverSource,form,admission,rows,clientCookie='',extraEdges=0}){
 const script=`let s='';for await(const c of process.stdin)s+=c;const a=JSON.parse(s);const http=await import('node:http');const crypto=await import('node:crypto');
const mod=await import('data:text/javascript;base64,'+Buffer.from(a.src).toString('base64'));
const config={host:a.host,key:crypto.randomBytes(32).toString('hex'),upstream:a.upstream,form:a.form,admission:a.admission,routes:[]};
const servers=[];for(let i=0;i<=a.extra;i++){const srv=mod.createPublicServer(config);await new Promise(r=>srv.listen(0,'127.0.0.1',r));servers.push(srv);}
const token=mod.formToken(config);
const call=(port,body)=>new Promise(resolve=>{const req=http.request({hostname:'127.0.0.1',port,path:'/form/'+a.form.id,method:'POST',headers:{Host:a.host,'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(body),Origin:'http://'+a.host,...(a.cookie?{Cookie:a.cookie}:{})}},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>resolve({status:res.statusCode,body:d}));});req.setTimeout(30000,()=>req.destroy(Error('timeout')));req.on('error',e=>resolve({status:0,body:e.message}));req.end(body);});
const out=await Promise.all(a.rows.map((r,i)=>call(servers[i%servers.length].address().port,new URLSearchParams({email:r.email,firstname:r.firstname,t:token}).toString())));
for(const srv of servers)srv.close();console.log(JSON.stringify(out));`;
 return inContainer(prefix+'-public-'+t,script,{src:serverSource??readFileSync(directory+'publishing/server.mjs','utf8'),host:host(t),upstream:'http://'+prefix+'-web-'+t,form,admission,rows,cookie:clientCookie,extra:extraEdges});
}
export const edgeFormConfig=form=>({id:form.id,name:form.alias,title:form.name,fields:Object.values(form.fields).filter(f=>f.type!=='button').map(f=>({name:f.alias,type:f.type,label:f.label}))});
export const save=(name,data)=>writeFileSync(new URL('./'+name+'.json',import.meta.url),JSON.stringify({run,capturedAt:new Date().toISOString(),...data},null,1)+'\n',{flag:'wx'});
