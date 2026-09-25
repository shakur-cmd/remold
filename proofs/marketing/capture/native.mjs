import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {api} from '../tenants/api.mjs';
const success=response=>{assert.equal(response.status,200,'Native read failed; do not advance the capture checkpoint');return response.data;};
const id=value=>{assert.ok(Number.isSafeInteger(value)&&value>=0,'Invalid native numeric ID');return value;};
export function normalizeSubmission(tenant,formId,value){
 assert.ok(['a','b'].includes(tenant));assert.equal(value.form.id,formId);id(value.id);assert.ok(value.id>0);
 const results=Object.fromEntries(Object.entries(value.results).sort(([a],[b])=>a.localeCompare(b)));
 assert.ok(Object.values(results).every(v=>v===null||typeof v==='string'),'Bounded form accepts scalar text results only');
 const record={tenant,formId,submissionId:value.id,contactId:value.lead?.id==null?null:id(value.lead.id),dateSubmitted:value.dateSubmitted,results};
 assert.equal(typeof record.dateSubmitted,'string');
 return {...record,sha256:createHash('sha256').update(JSON.stringify(record)).digest('hex')};
}
export function upperSubmissionId(tenant,formId,after=0){
 id(formId);id(after);const data=success(api(tenant,'/forms/'+formId+'/submissions?limit=1&orderBy=s.id&orderByDir=DESC'));
 const rows=Object.values(data.submissions);assert.ok(rows.length<=1);return Math.max(after,rows.length?id(rows[0].id):0);
}
export function readSubmissionPage(tenant,formId,{after,upper,limit=2}){
 id(formId);id(after);id(upper);assert.ok(upper>=after);assert.ok(Number.isSafeInteger(limit)&&limit>=1&&limit<=100);
 // The native DBAL submission query needs its explicit s alias; unqualified id returns HTTP 500.
 const query=new URLSearchParams({limit:String(limit),orderBy:'s.id',orderByDir:'ASC','where[0][col]':'s.id','where[0][expr]':'gt','where[0][val]':String(after),'where[1][col]':'s.id','where[1][expr]':'lte','where[1][val]':String(upper)});
 const data=success(api(tenant,'/forms/'+formId+'/submissions?'+query)),items=Object.values(data.submissions).map(s=>normalizeSubmission(tenant,formId,s));assert.ok(items.length<=limit);
 let last=after;for(const row of items){assert.ok(row.submissionId>last&&row.submissionId<=upper,'Native page violated requested bounds or order');last=row.submissionId;}
 const complete=items.length<limit||last===upper;
 return {items,after,upper,next:complete?upper:last,complete};
}
export function readEmailSuppression(tenant,contactId){
 id(contactId);const response=api(tenant,'/contacts/'+contactId);
 if(response.status===404)return {contactId,status:'missing',suppressed:true};
 const contact=success(response).contact;assert.equal(contact.id,contactId);assert.ok(Array.isArray(contact.doNotContact),'Missing authoritative suppression list must not mean subscribed');
 return {contactId,status:'present',suppressed:contact.doNotContact.some(row=>row.channel==='email')};
}
