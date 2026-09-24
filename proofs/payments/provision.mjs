import {mkdirSync,readFileSync,writeFileSync,existsSync}from'node:fs';
import{randomUUID}from'node:crypto';
import{provider,credentials,API_VERSION}from'./stripe.mjs';
const dir=new URL('./private/',import.meta.url);mkdirSync(dir,{recursive:true,mode:0o700});
const statePath=new URL('./private/provision.json',import.meta.url);
const state=existsSync(statePath)?JSON.parse(readFileSync(statePath,'utf8')):{run:randomUUID(),merchants:{}};
const save=()=>writeFileSync(statePath,JSON.stringify(state,null,2),{mode:0o600});save();
const stripe=provider(credentials());
const guard=await stripe.verify();
const evidence={level:'SANDBOX',apiVersion:API_VERSION,guard,accounts:[],receipts:stripe.receipts};
try{
 for(const name of ['A','B']){
  let account;
  if(state.merchants[name])account=await stripe.request('GET','/v1/accounts/'+state.merchants[name]);
  else{
   account=await stripe.request('POST','/v1/accounts',{'type':'standard','country':'US','metadata[remold_fixture]':state.run,'metadata[synthetic_merchant]':name},undefined,'remold-p4-'+state.run+'-'+name);
   state.merchants[name]=account.id;save();
  }
  evidence.accounts.push({fixture:name,id:account.id,type:account.type,controller:account.controller,charges_enabled:account.charges_enabled,payouts_enabled:account.payouts_enabled,capabilities:account.capabilities,requirements:{disabled_reason:account.requirements?.disabled_reason,currently_due:account.requirements?.currently_due,past_due:account.requirements?.past_due},country:account.country});
 }
 evidence.status='CREATED; merchant requirements need review before charging';
}catch(error){
 evidence.status='BLOCKED provisioning';evidence.failure={status:error.status,code:error.code??null,param:error.param??null,requestId:error.requestId??null};
 // Keep detailed provider text private; never echo a credential-bearing exception.
 writeFileSync(new URL('./private/provision-failure.txt',import.meta.url),String(error.providerMessage??error.message),{mode:0o600});
}
writeFileSync(new URL('./evidence/provision.json',import.meta.url),JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify(evidence));
