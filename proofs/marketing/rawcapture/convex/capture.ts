import {v,ConvexError} from 'convex/values';
import {mutation,query,internalMutation,type QueryCtx} from './_generated/server';
import {tenant,role,outcome} from './schema';
const digest=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
const refuse=(code:string)=>{throw new ConvexError({code});};
async function tenantFor(ctx:QueryCtx,key:string,want:'edge'|'reconciler'){
 if(!/^[a-f0-9]{64}$/.test(key))refuse('credential');
 const hash=await digest(key),row=await ctx.db.query('keys').withIndex('by_hash',q=>q.eq('keyHash',hash)).unique();
 if(!row||row.role!==want)refuse('credential');
 return row!.tenant;
}

// Run once per key with the local admin key (convex run). Re-registering the same key is a no-op; rebinding refuses.
export const registerKey=internalMutation({args:{keyHash:v.string(),tenant,role},handler:async(ctx,a)=>{
 if(!/^[a-f0-9]{64}$/.test(a.keyHash))refuse('invalid');
 const old=await ctx.db.query('keys').withIndex('by_hash',q=>q.eq('keyHash',a.keyHash)).unique();
 if(old){if(old.tenant!==a.tenant||old.role!==a.role)refuse('rebind');return old._id;}
 return ctx.db.insert('keys',{keyHash:a.keyHash,tenant:a.tenant,role:a.role});
}});

// Called by a tenant's public edge. Same key and same values returns the stored capture; same key with other values refuses.
export const capture=mutation({args:{key:v.string(),idempotencyKey:v.string(),email:v.string(),firstname:v.string()},handler:async(ctx,a)=>{
 const t=await tenantFor(ctx,a.key,'edge');
 if(!/^[a-f0-9]{32}$/.test(a.idempotencyKey)||a.email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email)||a.firstname.length>100||/[\x00-\x1f\x7f]/.test(a.firstname))refuse('invalid');
 const payloadSha256=await digest(JSON.stringify([a.email,a.firstname]));
 const old=await ctx.db.query('captures').withIndex('by_key',q=>q.eq('tenant',t).eq('idempotencyKey',a.idempotencyKey)).unique();
 if(old){if(old.payloadSha256!==payloadSha256)refuse('conflict');return {id:old._id,duplicate:true};}
 return {id:await ctx.db.insert('captures',{tenant:t,idempotencyKey:a.idempotencyKey,payloadSha256,email:a.email,firstname:a.firstname,receivedAt:Date.now(),status:'pending'}),duplicate:false};
}});

export const pending=query({args:{key:v.string(),limit:v.number()},handler:async(ctx,a)=>{
 const t=await tenantFor(ctx,a.key,'reconciler');if(!Number.isSafeInteger(a.limit)||a.limit<1||a.limit>100)refuse('invalid');
 const rows=await ctx.db.query('captures').withIndex('by_status',q=>q.eq('tenant',t).eq('status','pending')).take(a.limit);
 return rows.map(r=>({id:r._id,email:r.email,firstname:r.firstname}));
}});

// Records what the reconciler did. Settling twice with the same result is a no-op; a different result refuses.
export const settle=mutation({args:{key:v.string(),id:v.id('captures'),outcome,contactId:v.optional(v.number())},handler:async(ctx,a)=>{
 const t=await tenantFor(ctx,a.key,'reconciler'),row=await ctx.db.get(a.id);
 if(!row||row.tenant!==t)refuse('scope');
 if((a.outcome==='ambiguous')!==(a.contactId===undefined)||(a.contactId!==undefined&&(!Number.isSafeInteger(a.contactId)||a.contactId<1)))refuse('invalid');
 if(row!.status==='settled'){if(row!.outcome!==a.outcome||row!.contactId!==a.contactId)refuse('conflict');return 'duplicate';}
 await ctx.db.patch(a.id,{status:'settled',outcome:a.outcome,contactId:a.contactId});return 'settled';
}});

// Proof inventory for one tenant, read with that tenant's reconciler key.
export const inventory=query({args:{key:v.string()},handler:async(ctx,a)=>{
 const t=await tenantFor(ctx,a.key,'reconciler');
 const rows=await ctx.db.query('captures').withIndex('by_status',q=>q.eq('tenant',t)).take(1001);if(rows.length>1000)refuse('bound');
 return rows.map(r=>({id:r._id,tenant:r.tenant,idempotencyKey:r.idempotencyKey,email:r.email,firstname:r.firstname,status:r.status,outcome:r.outcome??null,contactId:r.contactId??null}));
}});
