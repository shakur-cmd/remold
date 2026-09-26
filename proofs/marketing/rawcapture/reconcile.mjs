// Feeds one tenant's pending captures to Mautic through its contacts API. It never edits an existing contact and
// never reads or writes do-not-contact.
// - Single writer: holds the tenant lease in Convex, renews it before every Mautic write, and every settle is fenced by it.
// - Exact, case-insensitive email lookup (API where eq), not the LIKE search that treats % and _ as wildcards.
// - Creates with the email only. Mautic's create upserts, so the first name is set only when the reply is 201 for an
//   id the lookup did not see; a 200 means someone else created the contact meanwhile, and it is left alone.
// - A capture Mautic refuses (400/422) settles as rejected with the reason; the run carries on.
// - A crash after create but before settle heals next run: the contact is then found and the capture settles as existing.
import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {api} from '../tenants/api.mjs';
import {keys,query,mutation} from './runtime.mjs';
const LEASE_MS=15000;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function exact(tenant,email){
 const p=new URLSearchParams({limit:'100','where[0][col]':'l.email','where[0][expr]':'eq','where[0][val]':email}),r=api(tenant,'/contacts?'+p);
 if(r.status!==200)throw Error('Mautic lookup failed '+r.status);
 return Object.values(r.data.contacts).filter(c=>String(c.fields.all.email??'').toLowerCase()===email.toLowerCase()).map(c=>c.id);
}
const refusal=r=>'Mautic refused create ('+r.status+'): '+String(r.data?.errors?.[0]?.message??'no message').slice(0,200);
export async function reconcile(tenant,{crashAfterCreate=false,pauseBeforeCreate=0}={}){
 if(!['a','b'].includes(tenant))throw Error('Unknown tenant');
 const key=keys()[tenant].reconciler,token=randomBytes(16).toString('hex'),log=[];
 for(const deadline=Date.now()+LEASE_MS+10000;;){
  try{await mutation('capture:acquire',{key,token,ttlMs:LEASE_MS});break;}
  catch(e){if(e.code!=='leased'||Date.now()>deadline)throw e;await sleep(1000);}
 }
 try{
  for(;;){
   const batch=await query('capture:pending',{key,limit:25});if(!batch.length)return log;
   for(const c of batch){
    await mutation('capture:renew',{key,token,ttlMs:LEASE_MS});
    const seen=exact(tenant,c.email);let outcome,contactId,reason;
    if(seen.length>1)outcome='ambiguous';
    else if(seen.length===1){outcome='existing';contactId=seen[0];}
    else{
     if(pauseBeforeCreate){process.stderr.write('PAUSED '+c.email+'\n');await sleep(pauseBeforeCreate);}
     await mutation('capture:renew',{key,token,ttlMs:LEASE_MS});
     const r=api(tenant,'/contacts/new','POST',{email:c.email});
     if(r.status===400||r.status===422){outcome='rejected';reason=refusal(r);}
     else if(r.status===201&&!seen.includes(r.data.contact.id)){
      contactId=r.data.contact.id;outcome='created';
      if(c.firstname){const p=api(tenant,'/contacts/'+contactId+'/edit','PATCH',{firstname:c.firstname});if(p.status!==200)throw Error('Mautic name update failed '+p.status);}
      if(crashAfterCreate)process.exit(86);
     }
     else if(r.status===200){outcome='existing';contactId=r.data.contact.id;}
     else throw Error('Mautic create failed '+r.status);
    }
    log.push({capture:c.id,outcome,contactId:contactId??null,reason:reason??null,result:await mutation('capture:settle',{key,lease:token,id:c.id,outcome,...(contactId===undefined?{}:{contactId}),...(reason===undefined?{}:{reason})})});
   }
  }
 }finally{await mutation('capture:release',{key,token}).catch(()=>{});}
}
if(process.argv[1]&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url)){
 const log=await reconcile(process.argv[2],{crashAfterCreate:process.env.REMOLD_RECONCILE_CRASH_AFTER_CREATE==='1',pauseBeforeCreate:Number(process.env.REMOLD_RECONCILE_PAUSE_BEFORE_CREATE_MS??0)});
 console.log(JSON.stringify(log));
}
