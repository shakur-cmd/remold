import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {ConvexHttpClient} from 'convex/browser';
import {makeFunctionReference} from 'convex/server';
import {withRecurring} from './local.mjs';
import {recurringAdapter} from './adapter.mjs';
import {provider,credentials,API_VERSION,OutcomeUnknown} from '../stripe.mjs';
import {claimJournal} from '../continuation.mjs';
import {listen} from '../webhooks.mjs';
import {proveNoPlatformFee} from '../invoice-contract.mjs';
import {boundedRecurringProvider,D,E,RUN} from './sandbox-policy.mjs';
assert.deepEqual(process.argv.slice(2), ['--run-reviewed-fixture'], 'Explicit reviewed fixture invocation required');
const manifest = JSON.parse(readFileSync(new URL('../evidence/recurring-sandbox-driver/source.json', import.meta.url)));
for (const [file,hash] of Object.entries(manifest.files)) assert.equal(createHash('sha256').update(readFileSync(new URL(file,import.meta.url))).digest('hex'),hash,'Unreviewed fixture source');
assert.equal(createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.keys(manifest.files).sort().map(file => [file,manifest.files[file]])))).digest('hex'),manifest.aggregate,'Source aggregate mismatch');
const approval = JSON.parse(readFileSync(new URL('../evidence/recurring-sandbox-driver/approval.json', import.meta.url)));
assert.equal(approval.aggregate,manifest.aggregate); assert.equal(approval.localSource,'APPROVE'); assert.equal(approval.sandboxExecution,'APPROVE');
const start = Math.floor(Date.now()/1000), raw = provider(credentials());
const registry = {clocks:new Map(),customers:new Set(),paymentMethods:new Set(),commands:new Map(),subscriptions:new Set(),schedules:new Set(),product:null,price:null};
const journal = claimJournal(fileURLToPath(new URL('./private/',import.meta.url)),RUN,{sourceAggregate:manifest.aggregate,start,apiVersion:API_VERSION,accounts:{D,E},exposureMinor:2709,maxCollectedMinor:1806});
const stripe = boundedRecurringProvider(raw,journal,registry,start), evidence = new URL('../evidence/recurring-sandbox-driver/',import.meta.url);
mkdirSync(evidence,{recursive:true});
const proof = {run:RUN,level:'SANDBOX Stripe; SERVICE isolated local Convex; SIM financial terms and identities',start,sourceAggregate:manifest.aggregate,objects:[],checks:[],observations:[],invoiceSnapshots:[],feeEvidence:[],webhooks:[],receipts:raw.receipts,counts:stripe.counts,complete:false};
const save = () => writeFileSync(new URL('provider.json',evidence),JSON.stringify(proof,null,2)+'\n');
const pass = label => {proof.checks.push(label); save(); console.log('PASS '+label);};
const get = (path,params={},account=D) => stripe.request('GET',path,params,account);
const write = (path,params,label) => stripe.request('POST',path,params,D,RUN+':'+label);
const completeList = async(path,params) => {const r=await get(path,{...params,limit:100});assert.equal(r.has_more,false);assert(Array.isArray(r.data)&&r.data.length<=100);assert.equal(new Set(r.data.map(x=>x.id)).size,r.data.length);return r.data;};
const scopedRefusal = async path => {for(const account of [E,undefined])await assert.rejects(stripe.request('GET',path,{},account),error=>error.status===404&&error.code==='resource_missing');};
const register = (kind,object,extra={}) => {assert.equal(object.livemode,false);assert(typeof object.id==='string');proof.objects.push({kind,id:object.id,...extra});save();};
async function clockReady(clock,target) {
    for(let n=0;n<60;n++) {
        const result=await get('/v1/test_helpers/test_clocks/'+clock.id); assert.equal(result.id,clock.id); assert.equal(result.livemode,false); assert.equal(result.name,RUN+'-'+clock.label);
        if(result.status==='ready'){assert.equal(result.frozen_time,target);clock.time=target;clock.deletesAfter=result.deletes_after;journal.append({kind:'clock-ready',...clock});return result;}
        assert.equal(result.status,'advancing'); if(n%15===0)console.log('Waiting for '+clock.label+' sandbox clock'); await new Promise(r=>setTimeout(r,2000));
    }
    throw Error('Clock readiness bound exceeded; preserve frozen resources');
}
async function advance(clock,target) {await write('/v1/test_helpers/test_clocks/'+clock.id+'/advance',{frozen_time:target},'advance-'+clock.label+'-'+target);await clockReady(clock,target);save();}
async function createClock(label) {const c=await write('/v1/test_helpers/test_clocks',{frozen_time:start,name:RUN+'-'+label},'clock-'+label);register('clock',c,{label,deletesAfter:c.deletes_after});const clock={id:c.id,label,time:start};registry.clocks.set(c.id,clock);await clockReady(clock,start);await scopedRefusal('/v1/test_helpers/test_clocks/'+c.id);return clock;}
async function createCustomer(clock) {
    const c=await write('/v1/customers',{name:'Synthetic recurring '+clock.label,test_clock:clock.id,'metadata[remold_fixture]':RUN},'customer-'+clock.label);register('customer',c,{clock:clock.id});
    const exact=await get('/v1/customers/'+c.id);assert.equal(exact.id,c.id);assert.equal(exact.test_clock,clock.id);assert.equal(exact.email,null);assert.equal(exact.balance,0);assert.equal(exact.metadata.remold_fixture,RUN);
    assert((await completeList('/v1/customers',{test_clock:clock.id})).some(x=>x.id===c.id));registry.customers.add(c.id);await scopedRefusal('/v1/customers/'+c.id);return c.id;
}
async function setup(customer,label,method='pm_card_visa') {
    const s=await write('/v1/setup_intents',{customer,usage:'off_session',payment_method:method,'payment_method_types[0]':'card',confirm:true},'setup-'+label);register('setup-intent',s,{customer});
    const exact=await get('/v1/setup_intents/'+s.id);assert.equal(exact.status,'succeeded');assert.equal(exact.usage,'off_session');assert.equal(exact.customer,customer);assert.equal(exact.livemode,false);
    const pm=await get('/v1/payment_methods/'+exact.payment_method);assert.equal(pm.customer,customer);assert.equal(pm.livemode,false);assert.equal(pm.type,'card');registry.paymentMethods.add(pm.id);return s.id;
}
let listener;
try {
    proof.platform=await raw.verify();
    await withRecurring(async({url,run,cwd})=>{
        const client=new ConvexHttpClient(url,{logger:false}),m=(name,args)=>client.mutation(makeFunctionReference(name),args),q=(name,args)=>client.query(makeFunctionReference(name),args);
        const f=run('harness:seed',{run:RUN,tokens:Array.from({length:10},()=>randomUUID())});journal.append({kind:'local-fixture',cwd,fixture:f});
        for(const [name,account] of [['A',D],['B',E]]) {
            const a=await stripe.request('GET','/v1/accounts/'+account,{},undefined);assert.equal(a.id,account);assert.equal(a.charges_enabled,true);assert.equal(a.payouts_enabled,true);assert.equal(a.capabilities.card_payments,'active');assert.equal(a.requirements.disabled_reason,null);
            for(const field of ['currently_due','past_due','pending_verification','errors'])assert.deepEqual(a.requirements[field],[]);
            assert.equal(a.type,'standard');assert.equal(a.controller.stripe_dashboard.type,'full');assert.equal((await get('/v1/balance',{},account)).livemode,false);
            run('payments:configureFixture',{binding:f[name].binding,adapterToken:f[name].adapter,account,environment:'SANDBOX',healthy:true});run('paymentFixture:role',{actor:f[name].actors.owner,role:'finance'});
        }
        listener=await listen(credentials(),async(event,digest)=>{if(event.account===D&&registry.customers.has(event.data.object.customer)){proof.webhooks.push({id:event.id,type:event.type,account:event.account,object:event.data.object.id,apiVersion:event.api_version,digest});save();}});
        const eClocks = await get('/v1/test_helpers/test_clocks',{limit:100},E);assert.equal(eClocks.has_more,false);proof.eClockIdsBefore=eClocks.data.map(x=>x.id).sort();save();
        pass('Pinned test platform and healthy connected accounts; signed forwarding ready');
        const F=await createClock('F');await advance(F,start+60);const customerF=await createCustomer(F);pass('Connected F clock create/advance, exact ownership and clock-filtered customer containment');
        const H=await createClock('H'),customerH=await createCustomer(H);
        const product=await write('/v1/products',{name:'Synthetic finite recurring service','metadata[remold_fixture]':RUN},'product');register('product',product);registry.product=product.id;
        const price=await write('/v1/prices',{product:product.id,currency:'usd',unit_amount:301,'recurring[interval]':'day','recurring[interval_count]':1,'recurring[usage_type]':'licensed',billing_scheme:'per_unit'},'price');register('price',price);registry.price=price.id;
        const goodF=await setup(customerF,'F-good'),goodH=await setup(customerH,'H-good');
        const localCustomer=new Map();for(const customer of [customerF,customerH])localCustomer.set(customer,await m('payments:registerCustomer',{token:f.A.adapter,binding:f.A.binding,externalId:customer,name:'Synthetic recurring customer'}));
        const owner=f.A.sessions.owner,adapter=recurringAdapter(stripe,client,f.A.adapter),contexts=new Map();
        const inspect=id=>q('recurring:inspect',{token:owner,id});
        async function registerCommand(id) {const command=await q('recurring:command',{token:f.A.adapter,id}),c=await q('recurring:context',{token:f.A.adapter,id:command.commitment});registry.commands.set('recurring:'+id,{kind:command.kind,customer:c.customer.externalId,start:c.plan.start,commitment:c.commitment._id,planHash:c.plan.hash,subscription:c.commitment.subscription,schedule:c.commitment.schedule});return command;}
        async function adopt(customer,clock,setupIntent,service) {
            const t=await clockReady(clock,clock.time),plan=await m('recurring:propose',{token:owner,customer:localCustomer.get(customer),service,price:price.id,setupIntent,testClock:clock.id,interval:'day',start:t.frozen_time,amountMinor:301,cycles:3,currency:'usd'});
            const acceptance=await client.action(makeFunctionReference('recurring:issueAcceptance'),{token:owner,plan});await m('recurring:accept',{plan,...acceptance});const a=await m('recurring:adopt',{token:owner,plan});contexts.set(a.id,{customer,clock,start:t.frozen_time});await registerCommand(a.command);assert.equal((await inspect(a.id)).commitment.reservedMinor,903);return a;
        }
        async function activate(a,lose=false) {
            if(lose){const original=stripe.request;stripe.request=async(method,path,...rest)=>{if(method==='POST'&&path==='/v1/subscription_schedules')return original(method,path,...rest.slice(0,3),{loseResponse:true});return original(method,path,...rest);};try{await assert.rejects(adapter.execute(a.command),OutcomeUnknown);}finally{stripe.request=original;}await adapter.reconcileActivation(a.command);}
            else await adapter.execute(a.command);
            const c=(await inspect(a.id)).commitment;assert(c.schedule&&c.subscription);registry.schedules.add(c.schedule);registry.subscriptions.add(c.subscription);proof.objects.push({kind:'commitment',local:a.id,schedule:c.schedule,subscription:c.subscription,customer:contexts.get(a.id).customer});await scopedRefusal('/v1/subscription_schedules/'+c.schedule);await scopedRefusal('/v1/subscriptions/'+c.subscription);
            const firstRows=await completeList('/v1/invoices',{customer:contexts.get(a.id).customer,subscription:c.subscription});assert.equal(firstRows.length,1,'First invoice identity not yet established; stop before advance');
            const first=await get('/v1/invoices/'+firstRows[0].id);assert.equal(first.id,firstRows[0].id);assert.equal(first.livemode,false);assert.equal(first.customer,contexts.get(a.id).customer);assert.equal(first.parent?.subscription_details?.subscription,c.subscription);
            contexts.get(a.id).firstInvoice=first.id;
            proof.invoiceSnapshots.push({label:'first invoice before advance',id:first.id,subscription:c.subscription,status:first.status,amountDue:first.amount_due,amountPaid:first.amount_paid,billingReason:first.billing_reason});save();return c;
        }
        async function observe(a,label,{allowUnresolved=false}={}) {
            const known=contexts.get(a.id),bound=(await inspect(a.id)).commitment;assert((await completeList('/v1/invoices',{customer:known.customer,subscription:bound.subscription})).some(row=>row.id===known.firstInvoice),'First invoice omitted before observation');
            await adapter.observe(a.id);const snapshot=await inspect(a.id);assert(snapshot.cycles.some(row=>row.invoice===known.firstInvoice),'First invoice absent from observed history');proof.observations.push({label,...snapshot});save();
            for(const cycle of snapshot.cycles){const invoice=await get('/v1/invoices/'+cycle.invoice);assert.equal(invoice.id,cycle.invoice);assert.equal(invoice.customer,contexts.get(a.id).customer);assert.equal(invoice.livemode,false);proof.invoiceSnapshots.push({label,id:invoice.id,status:invoice.status,amountDue:invoice.amount_due,amountPaid:invoice.amount_paid,attemptCount:invoice.attempt_count,nextPaymentAttempt:invoice.next_payment_attempt,periodStart:invoice.period_start,periodEnd:invoice.period_end,billingReason:invoice.billing_reason});
                for(const payment of cycle.payments)if(payment.status==='succeeded'&&!proof.feeEvidence.some(x=>x.paymentIntent===payment.id))proof.feeEvidence.push(await proveNoPlatformFee(stripe,{paymentIntent:payment.id,account:D,customer:contexts.get(a.id).customer,amountMinor:payment.amountMinor}));}
            save();assert(!snapshot.commitment.anomaly,'Provider recurring shape anomaly');if(!allowUnresolved)assert.equal(snapshot.commitment.complete,true);assert(snapshot.commitment.paidMinor<=903);return snapshot;
        }
        async function changeCard(a,seti){const cmd=await m('recurring:prepareCommand',{token:owner,id:a.id,kind:'card',setupIntent:seti});await registerCommand(cmd);await adapter.execute(cmd);}
        async function cancel(a){const cmd=await m('recurring:prepareCommand',{token:owner,id:a.id,kind:'cancel'});assert(cmd);await registerCommand(cmd);await adapter.execute(cmd);return observe(a,'cancelled-readback',{allowUnresolved:true});}
        const failed=await adopt(customerF,F,goodF,'finite-F');await activate(failed);const fstart=contexts.get(failed.id).start;
        await advance(F,fstart+3900);let fs=await observe(failed,'F first payment');assert.equal(fs.commitment.paidMinor,301);assert.equal(fs.cycles.length,1);pass('F first scheduled invoice finalized and paid with accepted line and no platform fee');
        const bad=await setup(customerF,'F-fail','pm_card_chargeCustomerFail');await changeCard(failed,bad);await advance(F,fstart+86400+3900);fs=await observe(failed,'F failed renewal');assert.equal(fs.commitment.paidMinor,301);assert.equal(fs.cycles.length,2);const unpaid=fs.cycles.find(x=>x.status==='open');assert(unpaid&&unpaid.payments.some(x=>x.status==='failed'));
        const retry=await setup(customerF,'F-recovery');await changeCard(failed,retry);
        for(let n=0;n<4&&fs.commitment.paidMinor===301;n++){const target=Math.min(F.time+21600,fstart+172800-1);if(target<=F.time)break;await advance(F,target);fs=await observe(failed,'F retry '+n);}
        assert([301,602].includes(fs.commitment.paidMinor));proof.retryObserved=fs.commitment.paidMinor===602;const priorInvoices=fs.cycles.map(x=>x.invoice),priorGross=fs.commitment.paidMinor;
        await m('harness:control',{token:owner,readonly:true});await cancel(failed);await advance(F,fstart+172800+3900);fs=await observe(failed,'F after cancellation',{allowUnresolved:true});assert.deepEqual(fs.cycles.map(x=>x.invoice).sort(),priorInvoices.sort());assert.equal(fs.commitment.paidMinor,priorGross);await m('harness:control',{token:owner,readonly:false});pass('F failed renewal, bounded automatic retry observation and readonly cancellation');
        const h1=await adopt(customerH,H,goodH,'finite-H');await activate(h1,true);const hstart=contexts.get(h1.id).start;
        for(let n=0;n<4;n++){await advance(H,hstart+n*86400+3900);const hs=await observe(h1,'H1 cycle '+n);assert.equal(hs.commitment.paidMinor,Math.min(n+1,3)*301);if(n===3){assert.equal(hs.commitment.state,'ended');assert.equal(hs.commitment.reservedMinor,0);assert.equal(hs.cycles.length,3);}}
        pass('H1 accepted response loss recovered without recreation; three cycles naturally exhausted');
        const h2=await adopt(customerH,H,goodH,'finite-H');await activate(h2);const h2start=contexts.get(h2.id).start;await advance(H,h2start+3900);let hs=await observe(h2,'H2 first payment');assert.equal(hs.commitment.paidMinor,301);await cancel(h2);await advance(H,h2start+86400+3900);hs=await observe(h2,'H2 after cancellation');assert.equal(hs.commitment.state,'cancelled');assert.equal(hs.commitment.paidMinor,301);assert.equal(hs.cycles.length,1);pass('H2 fresh accepted replacement and cancellation produce one cycle only');
        proof.final=await Promise.all([failed,h1,h2].map(a=>inspect(a.id)));assert(proof.final.reduce((n,x)=>n+x.commitment.paidMinor,0)<=1806);const finalE=await get('/v1/test_helpers/test_clocks',{limit:100},E);assert.equal(finalE.has_more,false);proof.eClockIdsAfter=finalE.data.map(x=>x.id).sort();assert.deepEqual(proof.eClockIdsAfter,proof.eClockIdsBefore);proof.complete=true;proof.remaining=['future-start binding/cancellation','signed durable recurring ingestion','monthly cadence','independent provider readback','full P4/I1/I7 and live financial gates'];save();
    });
} catch(error) {proof.failure={name:error.name,message:error instanceof OutcomeUnknown?'Outcome unknown':String(error.message),status:error.status??null,code:error.code??null};save();console.error('STOP: '+proof.failure.message);process.exitCode=1;}
finally {await listener?.stop();save();}
