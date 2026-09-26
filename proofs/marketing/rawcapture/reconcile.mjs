// Feeds one tenant's pending captures to Mautic through its contacts API. It only creates contacts for unknown
// emails, never edits an existing contact and never reads or writes do-not-contact. Run one reconciler per tenant.
// Once per capture across restarts: a crash after create but before settle is recovered on the next run, because the
// created contact is then found by email and the capture settles as existing without a second create.
import assert from 'node:assert/strict';
import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {api} from '../tenants/api.mjs';
import {keys,query,mutation} from './runtime.mjs';
const ok=r=>{assert.ok(r.status>=200&&r.status<300,'Mautic API refused '+r.status);return r.data;};
function contactsWithEmail(tenant,email){
 const found=ok(api(tenant,'/contacts?limit=100&search='+encodeURIComponent(email)));assert.ok(Number(found.total)<100,'Do not truncate the email match set');
 return Object.values(found.contacts).filter(c=>String(c.fields.all.email??'').toLowerCase()===email.toLowerCase()).map(c=>c.id);
}
export async function reconcile(tenant,{crashAfterCreate=false}={}){
 assert.ok(['a','b'].includes(tenant));const key=keys()[tenant].reconciler,log=[];
 for(;;){
  const batch=await query('capture:pending',{key,limit:25});if(!batch.length)return log;
  for(const c of batch){
   const matches=contactsWithEmail(tenant,c.email);let outcome,contactId;
   if(matches.length>1)outcome='ambiguous';
   else if(matches.length===1){outcome='existing';contactId=matches[0];}
   else{
    // The captured first name is only used to start a brand-new contact. No consent or suppression field is sent.
    contactId=ok(api(tenant,'/contacts/new','POST',{email:c.email,firstname:c.firstname})).contact.id;outcome='created';
    if(crashAfterCreate)process.exit(86);
   }
   log.push({capture:c.id,outcome,contactId:contactId??null,result:await mutation('capture:settle',{key,id:c.id,outcome,...(contactId===undefined?{}:{contactId})})});
  }
 }
}
if(process.argv[1]&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url)){
 const log=await reconcile(process.argv[2],{crashAfterCreate:process.env.REMOLD_RECONCILE_CRASH_AFTER_CREATE==='1'});
 console.log(JSON.stringify(log));
}
