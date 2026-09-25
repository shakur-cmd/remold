import {v} from 'convex/values';
import {mutation,query,type MutationCtx,type QueryCtx} from './_generated/server';
import type {Id} from './_generated/dataModel';
import {item,observation,tenant} from './schema';
const digest=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
const integer=(value:number)=>{if(!Number.isSafeInteger(value)||value<0)throw Error('INTEGER_BOUND');};
async function instance(ctx:QueryCtx|MutationCtx,id:Id<'instances'>,key:string){const row=await ctx.db.get(id);if(!row||row.keyHash!==await digest(key))throw Error('INSTANCE_CREDENTIAL');return row;}
// This seed belongs only to an isolated anonymous local proof. It is not product authentication or a CRM mutation.
export const seed=mutation({args:{tenant,key:v.string(),formId:v.number()},handler:async(ctx,a)=>{
 if(!/^[a-f0-9]{64}$/.test(a.key))throw Error('KEY_BOUND');integer(a.formId);if(a.formId===0)throw Error('FORM_BOUND');
 const old=await ctx.db.query('instances').withIndex('by_tenant',q=>q.eq('tenant',a.tenant)).unique();
 const keyHash=await digest(a.key);if(old){if(old.keyHash!==keyHash||old.formId!==a.formId)throw Error('INSTANCE_ALREADY_BOUND');return old._id;}
 return ctx.db.insert('instances',{tenant:a.tenant,keyHash,formId:a.formId,cursor:0,pending:null,last:null});
}});
export const page=mutation({args:{instance:v.id('instances'),key:v.string(),scan:v.string(),after:v.number(),upper:v.number(),next:v.number(),complete:v.boolean(),items:v.array(item)},handler:async(ctx,a)=>{
 const box=await instance(ctx,a.instance,a.key);for(const value of [a.after,a.upper,a.next])integer(value);
 if(!a.scan||a.scan.length>100||a.upper<a.after||a.items.length>25)throw Error('PAGE_BOUND');
 let last=a.after;for(const row of a.items){
  integer(row.submissionId);if(row.contactId!==null)integer(row.contactId);
  if(row.tenant!==box.tenant||row.formId!==box.formId||row.submissionId<=last||row.submissionId>a.upper)throw Error('CAPTURE_SCOPE');last=row.submissionId;
  if(Object.keys(row.results).length>10||Object.entries(row.results).some(([k,v])=>k.length>100||(v!==null&&v.length>1000))||row.dateSubmitted.length>100)throw Error('CAPTURE_BOUND');
  const record={tenant:row.tenant,formId:row.formId,submissionId:row.submissionId,contactId:row.contactId,dateSubmitted:row.dateSubmitted,results:Object.fromEntries(Object.entries(row.results).sort(([x],[y])=>x.localeCompare(y)))};
  if(await digest(JSON.stringify(record))!==row.sha256)throw Error('CAPTURE_DIGEST');
 }
 if(a.next!==(a.complete?a.upper:last)||(!a.complete&&a.items.length===0))throw Error('PAGE_PROGRESS');
 const fingerprint=await digest(JSON.stringify([a.after,a.upper,a.next,a.complete,a.items]));
 if(box.last?.scan===a.scan){if(box.last.receipts.find(r=>r.after===a.after)?.fingerprint!==fingerprint)throw Error('REPLAY_CHANGED');return 'duplicate';}
 const pending=box.pending??{scan:a.scan,from:box.cursor,upper:a.upper,next:box.cursor,finished:false,receipts:[],items:[]};
 if(pending.scan!==a.scan||pending.upper!==a.upper)throw Error('TRAVERSAL_IN_PROGRESS');
 const receipt=pending.receipts.find(r=>r.after===a.after);if(receipt){if(receipt.fingerprint!==fingerprint)throw Error('REPLAY_CHANGED');return 'duplicate';}
 if(pending.finished||a.after!==pending.next||a.upper<box.cursor)throw Error('PAGE_GAP');
 if(pending.items.length+a.items.length>100||pending.receipts.length>=128)throw Error('TRAVERSAL_BOUND');
 pending.items.push(...a.items);pending.receipts.push({after:a.after,fingerprint});pending.next=a.next;pending.finished=a.complete;
 await ctx.db.patch(box._id,{pending});return 'staged';
}});
export const finish=mutation({args:{instance:v.id('instances'),key:v.string(),scan:v.string(),observations:v.array(observation)},handler:async(ctx,a)=>{
 const box=await instance(ctx,a.instance,a.key);if(box.last?.scan===a.scan)return {...box.last.result,duplicate:true};
 const p=box.pending;if(!p||p.scan!==a.scan||!p.finished||p.next!==p.upper)throw Error('TRAVERSAL_INCOMPLETE');
 const existing=await ctx.db.query('captures').withIndex('by_instance_submission',q=>q.eq('instance',box._id)).take(101);if(existing.length>100)throw Error('CAPTURE_BOUND');
 const expected=[...new Set([...existing.map(c=>c.data.contactId),...p.items.map(c=>c.contactId)].filter((n):n is number=>n!==null))].sort((x,y)=>x-y);
 const actual=a.observations.map(o=>o.contactId).sort((x,y)=>x-y);if(JSON.stringify(actual)!==JSON.stringify(expected))throw Error('CONSENT_COVERAGE');
 for(const o of a.observations){integer(o.contactId);if(o.status==='missing'&&!o.suppressed)throw Error('MISSING_CONTACT_MUST_SUPPRESS');}
 let added=0,suppressionChanges=0;const actor='marketing-poller:'+box.tenant;
 for(const data of p.items){const old=existing.find(c=>c.data.submissionId===data.submissionId);if(old){if(old.data.sha256!==data.sha256)throw Error('CAPTURE_INTEGRITY');continue;}
  await ctx.db.insert('captures',{instance:box._id,data});await ctx.db.insert('events',{instance:box._id,actor,kind:'capture',subject:data.submissionId,fingerprint:data.sha256});added++;
 }
 if(existing.length+added>100)throw Error('CAPTURE_BOUND');
 for(const data of a.observations){const old=await ctx.db.query('suppression').withIndex('by_instance_contact',q=>q.eq('instance',box._id).eq('data.contactId',data.contactId)).unique();
  if(old&&old.data.status===data.status&&old.data.suppressed===data.suppressed)continue;
  if(old)await ctx.db.patch(old._id,{data});else await ctx.db.insert('suppression',{instance:box._id,data});
  await ctx.db.insert('events',{instance:box._id,actor,kind:'suppression',subject:data.contactId,fingerprint:await digest(JSON.stringify(data))});suppressionChanges++;
 }
 const result={added,suppressionChanges,cursor:p.upper};await ctx.db.patch(box._id,{cursor:p.upper,pending:null,last:{scan:p.scan,receipts:p.receipts,result}});return {...result,duplicate:false};
}});
export const snapshot=query({args:{instance:v.id('instances'),key:v.string()},handler:async(ctx,a)=>{
 const box=await instance(ctx,a.instance,a.key);
 return {tenant:box.tenant,formId:box.formId,cursor:box.cursor,pending:box.pending,last:box.last,captures:await ctx.db.query('captures').withIndex('by_instance_submission',q=>q.eq('instance',box._id)).collect(),suppression:await ctx.db.query('suppression').withIndex('by_instance_contact',q=>q.eq('instance',box._id)).collect(),events:await ctx.db.query('events').withIndex('by_instance',q=>q.eq('instance',box._id)).collect()};
}});
