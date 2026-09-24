import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {trustedAdapter} from './adapter.mjs';
export async function boundary({stripe,client,m,q,h,run,account,externalCustomer,runId,check,objects}){
 const f=run('harness:seed',{run:randomUUID(),tokens:Array.from({length:10},()=>randomUUID())});
 run('payments:configureFixture',{binding:f.A.binding,adapterToken:f.A.adapter,account,environment:'SANDBOX',healthy:true});f.A.key={provider:'stripe',environment:'SANDBOX',account};
 const customer=await m('registerCustomer',{token:f.A.adapter,binding:f.A.binding,externalId:externalCustomer,name:'Synthetic boundary customer'});
 const doc=await m('prepareInvoice',{token:f.A.sessions.owner,customer,amountMinor:109,currency:'usd',kind:'invoice'});
 const adapter=trustedAdapter(stripe,client,f);
 const grant=target=>h('grant',{token:f.A.sessions.owner,target,capability:'billing.collect',scope:{kind:'bindings',bindings:[f.A.binding],maxAmountMinor:109,currency:'usd',maxRecipients:1},mode:'direct',delegate:false,expires:Date.now()+60000});
 await grant(f.A.actors.manager);
 const params={customer:externalCustomer,amount:109,currency:'usd',payment_method:'pm_card_visa','payment_method_types[]':'card',confirm:true};
 const writesBefore=stripe.receipts.filter(r=>r.method!=='GET').length;
 await check('Firing an agent before exact H0 final permit produces no provider write',async()=>{
  await assert.rejects(adapter.execute('A',doc,params,'POST','/v1/payment_intents',{callerToken:f.A.sessions.manager,stage:'before-permit',beforePermit:()=>h('revoke',{token:f.A.sessions.owner,target:f.A.actors.manager})}),/stale claim|authority epoch|cancel/);
  assert.equal(stripe.receipts.filter(r=>r.method!=='GET').length,writesBefore);
 });
 await grant(f.A.actors.child);
 await check('Firing after consumed final permit records only the bounded late provider result',async()=>{
  const out=await adapter.execute('A',doc,params,'POST','/v1/payment_intents',{callerToken:f.A.sessions.child,stage:'after-permit',afterPermit:()=>h('revoke',{token:f.A.sessions.owner,target:f.A.actors.child})});
  assert.equal(out.result.status,'succeeded');assert.equal(out.receipt.late,true);assert.equal(out.result.amount,109);
  objects.push({kind:'bounded-late',account,id:out.result.id,operation:out.operation,late:out.receipt.late,amountMinor:109});
  await assert.rejects(adapter.execute('A',doc,params,'POST','/v1/payment_intents',{callerToken:f.A.sessions.child,stage:'after-fire-new'}),/inactive/);
 });
 await check('Frozen H0 general refund still refuses readonly at its final authority boundary',async()=>{
  const before=stripe.receipts.filter(r=>r.method!=='GET').length;
  const id=await h('propose',{token:f.A.sessions.owner,logical:doc+':frozen-readonly-refund',binding:f.A.binding,capability:'billing.refund',payload:{content:'synthetic readonly boundary',audience:[externalCustomer],audienceVersion:1,destination:account,schedule:0,amountMinor:1,currency:'usd',workflowVersion:1},reservationUnits:1,maxSteps:1});
  await h('approve',{token:f.A.sessions.owner,id,expires:Date.now()+60000});const worker='boundary',claim=await h('claim',{token:f.A.sessions.owner,id,worker});await h('control',{token:f.A.sessions.owner,readonly:true});await assert.rejects(h('permit',{token:f.A.adapter,id,worker,...claim}),/readonly/);
  await assert.rejects(adapter.execute('A',doc,{},'POST','/v1/refunds',{capability:'billing.collect'}),/general collection route refused/);
  assert.equal(stripe.receipts.filter(r=>r.method!=='GET').length,before);
 });
}
