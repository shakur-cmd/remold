import {v,ConvexError} from 'convex/values';
import {mutation,query,internalMutation,type QueryCtx,type MutationCtx} from './_generated/server';
import {tenant,role,outcome} from './schema';
const digest=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
const refuse=(code:string)=>{throw new ConvexError({code});};
// Deliberately narrower than RFC 5321: plain ASCII local part and hostname, no quoting, no %, *, ', & or spaces, and at
// most 64 characters in total because Mautic stores no more. Keep in step with publishing/server.mjs.
const EMAIL=/^[A-Za-z0-9_+-]+(\.[A-Za-z0-9_+-]+)*@([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const validEmail=(e:string)=>e.length<=64&&EMAIL.test(e);
const NAME_MAX=64;
const TOKEN=/^[a-f0-9]{32}$/;
async function tenantFor(ctx:QueryCtx,key:string,want:'edge'|'reconciler'){
 if(!/^[a-f0-9]{64}$/.test(key))refuse('credential');
 const hash=await digest(key),row=await ctx.db.query('keys').withIndex('by_hash',q=>q.eq('keyHash',hash)).unique();
 if(!row||row.role!==want)refuse('credential');
 return row!.tenant;
}
const leaseOf=(ctx:QueryCtx,t:'a'|'b')=>ctx.db.query('leases').withIndex('by_tenant',q=>q.eq('tenant',t)).unique();
const ttl=(ms:number)=>{if(!Number.isSafeInteger(ms)||ms<1||ms>60000)refuse('invalid');return ms;};

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
 if(!TOKEN.test(a.idempotencyKey)||!validEmail(a.email)||a.firstname.length>NAME_MAX||/[\x00-\x1f\x7f]/.test(a.firstname))refuse('invalid');
 const payloadSha256=await digest(JSON.stringify([a.email,a.firstname]));
 const old=await ctx.db.query('captures').withIndex('by_key',q=>q.eq('tenant',t).eq('idempotencyKey',a.idempotencyKey)).unique();
 if(old){if(old.payloadSha256!==payloadSha256)refuse('conflict');return {id:old._id,duplicate:true};}
 return {id:await ctx.db.insert('captures',{tenant:t,idempotencyKey:a.idempotencyKey,payloadSha256,email:a.email,firstname:a.firstname,receivedAt:Date.now(),status:'pending'}),duplicate:false};
}});

// Take the tenant's lease if it is free, expired or already ours.
export const acquire=mutation({args:{key:v.string(),token:v.string(),ttlMs:v.number()},handler:async(ctx,a)=>{
 const t=await tenantFor(ctx,a.key,'reconciler');if(!TOKEN.test(a.token))refuse('invalid');const expiresAt=Date.now()+ttl(a.ttlMs);
 const old=await leaseOf(ctx,t);
 if(old&&old.token!==a.token&&old.expiresAt>Date.now())refuse('leased');
 if(old)await ctx.db.patch(old._id,{token:a.token,expiresAt});else await ctx.db.insert('leases',{tenant:t,token:a.token,expiresAt});
 return expiresAt;
}});
async function live(ctx:MutationCtx,t:'a'|'b',token:string){const l=await leaseOf(ctx,t);if(!l||l.token!==token||l.expiresAt<=Date.now())refuse('stale');return l!;}
export const renew=mutation({args:{key:v.string(),token:v.string(),ttlMs:v.number()},handler:async(ctx,a)=>{
 const t=await tenantFor(ctx,a.key,'reconciler'),l=await live(ctx,t,a.token),expiresAt=Date.now()+ttl(a.ttlMs);await ctx.db.patch(l._id,{expiresAt});return expiresAt;
}});
export const release=mutation({args:{key:v.string(),token:v.string()},handler:async(ctx,a)=>{
 const t=await tenantFor(ctx,a.key,'reconciler'),l=await leaseOf(ctx,t);if(l&&l.token===a.token)await ctx.db.delete(l._id);
}});

export const pending=query({args:{key:v.string(),limit:v.number()},handler:async(ctx,a)=>{
 const t=await tenantFor(ctx,a.key,'reconciler');if(!Number.isSafeInteger(a.limit)||a.limit<1||a.limit>100)refuse('invalid');
 const rows=await ctx.db.query('captures').withIndex('by_status',q=>q.eq('tenant',t).eq('status','pending')).take(a.limit);
 return rows.map(r=>({id:r._id,email:r.email,firstname:r.firstname}));
}});

// Records what the reconciler did, fenced by the live lease. Settling twice with the same result is a no-op; a different result refuses.
export const settle=mutation({args:{key:v.string(),lease:v.string(),id:v.id('captures'),outcome,contactId:v.optional(v.number()),reason:v.optional(v.string())},handler:async(ctx,a)=>{
 const t=await tenantFor(ctx,a.key,'reconciler');await live(ctx,t,a.lease);
 const row=await ctx.db.get(a.id);if(!row||row.tenant!==t)refuse('scope');
 const linked=a.outcome==='created'||a.outcome==='existing';
 if(linked!==(a.contactId!==undefined)||(a.contactId!==undefined&&(!Number.isSafeInteger(a.contactId)||a.contactId<1))||(a.outcome==='rejected'&&a.reason===undefined)||(a.reason!==undefined&&a.outcome!=='rejected'&&a.outcome!=='created')||(a.reason!==undefined&&(a.reason.length<1||a.reason.length>300)))refuse('invalid');
 if(row!.status==='settled'){if(row!.outcome!==a.outcome||row!.contactId!==a.contactId)refuse('conflict');return 'duplicate';}
 await ctx.db.patch(a.id,{status:'settled',outcome:a.outcome,contactId:a.contactId,reason:a.reason});return 'settled';
}});

// Proof inventory for one tenant, read with that tenant's reconciler key.
export const inventory=query({args:{key:v.string()},handler:async(ctx,a)=>{
 const t=await tenantFor(ctx,a.key,'reconciler');
 const rows=await ctx.db.query('captures').withIndex('by_status',q=>q.eq('tenant',t)).take(2001);if(rows.length>2000)refuse('bound');
 return rows.map(r=>({id:r._id,tenant:r.tenant,idempotencyKey:r.idempotencyKey,email:r.email,firstname:r.firstname,status:r.status,outcome:r.outcome??null,contactId:r.contactId??null,reason:r.reason??null}));
}});
