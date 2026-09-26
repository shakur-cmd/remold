import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {ConvexHttpClient} from 'convex/browser';
import {makeFunctionReference} from 'convex/server';
import {withRecurring} from './local.mjs';
import {recurringAdapter} from './adapter.mjs';
import {preserveFailure} from './provider-evidence.mjs';
import {settledCancellation} from './settled-cancellation.mjs';
import {provider,credentials,API_VERSION,OutcomeUnknown} from '../stripe.mjs';
import {claimJournal} from '../continuation.mjs';
import {listen} from '../webhooks.mjs';
import {proveNoPlatformFee} from '../invoice-contract.mjs';
import {boundedRecurringProvider,D,E,RUN} from './sandbox-policy.mjs';
import {loadSecondStop,NEXT_CONTINUATION as CONTINUATION} from './continuation.mjs';
assert.deepEqual(process.argv.slice(2), ['--continue-reviewed-fixture'], 'Explicit reviewed fixture invocation required');
const manifest = JSON.parse(readFileSync(new URL('../evidence/recurring-sandbox-continuation-2/source.json', import.meta.url)));
for (const [file,hash] of Object.entries(manifest.files)) assert.equal(createHash('sha256').update(readFileSync(new URL(file,import.meta.url))).digest('hex'),hash,'Unreviewed fixture source');
assert.equal(createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.keys(manifest.files).sort().map(file => [file,manifest.files[file]])))).digest('hex'),manifest.aggregate,'Source aggregate mismatch');
const approval = JSON.parse(readFileSync(new URL('../evidence/recurring-sandbox-continuation-2/approval.json', import.meta.url)));
assert.equal(approval.aggregate,manifest.aggregate); assert.equal(approval.localSource,'APPROVE'); assert.equal(approval.sandboxExecution,'APPROVE');
const prior = loadSecondStop();
const start = prior.start, raw = provider(credentials()), registry = prior.registry;
const journal = claimJournal(fileURLToPath(new URL('./private/',import.meta.url)),CONTINUATION,{parentJournalSha256:prior.journalSha,sourceAggregate:manifest.aggregate,start,apiVersion:API_VERSION,accounts:{D,E},exposureMinor:2709,maxCollectedMinor:1806});
const stripe = boundedRecurringProvider(raw,journal,registry,start,prior.spent), evidence = new URL('../evidence/recurring-sandbox-continuation-2/',import.meta.url);
mkdirSync(evidence,{recursive:true});
const proof = {run:CONTINUATION,continues:prior.proof.run,priorJournalSha256:prior.journalSha,level:'SANDBOX Stripe; SERVICE isolated local Convex; SIM financial terms and identities',start,sourceAggregate:manifest.aggregate,objects:structuredClone(prior.proof.objects),knownSetupInventory:prior.setupInventory,checks:[],observations:[],invoiceSnapshots:[],feeEvidence:[],webhooks:[],receipts:raw.receipts,counts:stripe.counts,complete:false};
const save = () => writeFileSync(new URL('provider.json',evidence),JSON.stringify(proof,null,2)+'\n');
const pass = label => {proof.checks.push(label); save(); console.log('PASS '+label);};
const get = (path,params={},account=D) => stripe.request('GET',path,params,account);
const write = (path,params,label) => stripe.request('POST',path,params,D,CONTINUATION+':'+label);
const completeList = async(path,params) => {const r=await get(path,{...params,limit:100});assert.equal(r.has_more,false);assert(Array.isArray(r.data)&&r.data.length<=100);assert.equal(new Set(r.data.map(x=>x.id)).size,r.data.length);return r.data;};
const scopedRefusal = async path => {for(const account of [E,undefined])await assert.rejects(stripe.request('GET',path,{},account),error=>error.status===404&&error.code==='resource_missing');};
async function clockReady(clock,target) {
    for(let n=0;n<60;n++) {
        const result=await get('/v1/test_helpers/test_clocks/'+clock.id); assert.equal(result.id,clock.id); assert.equal(result.livemode,false); assert.equal(result.name,RUN+'-'+clock.label);
        if(result.status==='ready'){assert.equal(result.frozen_time,target);clock.time=target;clock.deletesAfter=result.deletes_after;journal.append({kind:'clock-ready',...clock});return result;}
        assert.equal(result.status,'advancing'); if(n%15===0)console.log('Waiting for '+clock.label+' sandbox clock'); await new Promise(r=>setTimeout(r,2000));
    }
    throw Error('Clock readiness bound exceeded; preserve frozen resources');
}
async function advance(clock,target) {await write('/v1/test_helpers/test_clocks/'+clock.id+'/advance',{frozen_time:target},'advance-'+clock.label+'-'+target);await clockReady(clock,target);save();}
async function verifySetup(setupId,customer) {
    const exact=await get('/v1/setup_intents/'+setupId);assert.equal(exact.id,setupId);assert.equal(exact.status,'succeeded');assert.equal(exact.usage,'off_session');assert.equal(exact.customer,customer);assert.equal(exact.livemode,false);
    const pm=await get('/v1/payment_methods/'+exact.payment_method);assert.equal(pm.id,exact.payment_method);assert.equal(pm.customer,customer);assert.equal(pm.livemode,false);assert.equal(pm.type,'card');registry.paymentMethods.add(pm.id);return setupId;
}

let listener;
try {
    proof.platform=await raw.verify();
    await withRecurring(async({url,cwd,run})=>{
        const client=new ConvexHttpClient(url,{logger:false}),m=(name,args)=>client.mutation(makeFunctionReference(name),args),q=(name,args)=>client.query(makeFunctionReference(name),args);
        const f=prior.fixture;journal.append({kind:'restored-local-fixture',cwd,parentJournalSha256:prior.journalSha});
        for(const [name,account] of [['A',D],['B',E]]) {
            const a=await stripe.request('GET','/v1/accounts/'+account,{},undefined);assert.equal(a.id,account);assert.equal(a.charges_enabled,true);assert.equal(a.payouts_enabled,true);assert.equal(a.capabilities.card_payments,'active');assert.equal(a.requirements.disabled_reason,null);
            for(const field of ['currently_due','past_due','pending_verification','errors'])assert.deepEqual(a.requirements[field],[]);
            assert.equal(a.type,'standard');assert.equal(a.controller.stripe_dashboard.type,'full');assert.equal((await get('/v1/balance',{},account)).livemode,false);

        }
        listener=await listen(credentials(),async(event,digest)=>{if(event.account===D&&registry.customers.has(event.data.object.customer)){proof.webhooks.push({id:event.id,type:event.type,account:event.account,object:event.data.object.id,apiVersion:event.api_version,digest});save();}});
        const eClocks = await get('/v1/test_helpers/test_clocks',{limit:100},E);assert.equal(eClocks.has_more,false);proof.eClockIdsBefore=eClocks.data.map(x=>x.id).sort();save();
        pass('Pinned test platform and healthy connected accounts; signed forwarding ready');
        const {F,H,customerF,customerH}=prior;
        for(const clock of [F,H]){assert(Date.now()/1000<clock.deletesAfter,'Clock expiry reached');await clockReady(clock,clock.time);}
        for(const [customer,clock] of [[customerF,F],[customerH,H]]){
            const c=await get('/v1/customers/'+customer);assert.equal(c.id,customer);assert.equal(c.livemode,false);assert.equal(c.test_clock,clock.id);assert.equal(c.email,null);assert.equal(c.balance,0);assert.equal(c.metadata.remold_fixture,RUN);
            const scoped=await completeList('/v1/customers',{test_clock:clock.id});assert.deepEqual(scoped.map(x=>x.id),[customer],'Clock contains another customer');
            for(const [path,params,expected] of [['/v1/subscription_schedules',{customer},customer===customerF?[prior.commitment.schedule]:[]],['/v1/subscriptions',{customer,status:'all'},customer===customerF?[prior.commitment.subscription]:[]],['/v1/invoices',{customer},customer===customerF?prior.local.cycles.map(c=>c.invoice):[]]])assert.deepEqual((await completeList(path,params)).map(x=>x.id).sort(),expected.sort(),'Unexpected prior provider inventory');
        }
        const product=await get('/v1/products/'+registry.product);assert.equal(product.id,registry.product);assert.equal(product.livemode,false);assert.equal(product.active,true);assert.equal(product.metadata.remold_fixture,RUN);
        const price=await get('/v1/prices/'+registry.price);assert.equal(price.id,registry.price);assert.equal(price.product,product.id);assert.equal(price.livemode,false);assert.equal(price.active,true);assert.equal(price.unit_amount,301);assert.equal(price.currency,'usd');assert.equal(price.recurring.interval,'day');assert.equal(price.recurring.interval_count,1);assert.equal(price.recurring.usage_type,'licensed');
        await verifySetup(prior.setupF,customerF);const goodH=await verifySetup(prior.setupH,customerH);
        const restored=await q('recurring:inspect',{token:f.A.sessions.owner,id:prior.commitment.local});assert.deepEqual(restored,{commitment:prior.local.commitment,commands:prior.local.commands,cycles:prior.local.cycles},'Existing local ledger changed');
        const initial=await q('recurring:context',{token:f.A.adapter,id:prior.commitment.local});assert.equal(initial.account,D);assert.equal(initial.environment,'SANDBOX');assert.equal(initial.plan.testClock,F.id);assert.equal(initial.plan.price,price.id);assert.equal(initial.plan.setupIntent,prior.setupF);assert.equal(initial.plan.start,start+60);assert.equal(initial.customer.externalId,customerF);
        const orgs=run('harness:dump',{orgs:[f.A.org]}).orgs;assert.equal(orgs.length,1);assert.equal(orgs[0]._id,f.A.org);assert.equal(orgs[0].readonly,true,'F cancellation must reconcile while readonly');
        for(const inventory of prior.setupInventory){const current=await completeList('/v1/setup_intents',{customer:inventory.customer});assert.deepEqual(current.map(i=>i.id).sort(),inventory.ids.slice().sort(),'Known setup inventory changed');}
        const localCustomer=new Map([[customerF,initial.customer._id]]);
        // H has no prior agreement, so registering its existing provider customer is local-only.
        localCustomer.set(customerH,await m('payments:registerCustomer',{token:f.A.adapter,binding:f.A.binding,externalId:customerH,name:'Synthetic recurring customer'}));
        pass('Exact frozen clocks, owned assets, spent budget and original local ledger restored');
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
        async function cancel(a){
            const cmd=await m('recurring:prepareCommand',{token:owner,id:a.id,kind:'cancel'});assert(cmd);await registerCommand(cmd);await adapter.execute(cmd);
            const c=(await inspect(a.id)).commitment;
            await settledCancellation(async()=>{const schedule=await get('/v1/subscription_schedules/'+c.schedule),subscription=await get('/v1/subscriptions/'+c.subscription),invoice=await get('/v1/invoices/'+contexts.get(a.id).firstInvoice);assert.equal(schedule.id,c.schedule);assert.equal(subscription.id,c.subscription);assert.equal(schedule.status,'canceled');assert.equal(subscription.status,'canceled');return{schedule,subscription,invoice};});
            return observe(a,'cancelled-readback',{allowUnresolved:true});
        }
        const failed={id:prior.commitment.local},fstart=initial.plan.start;contexts.set(failed.id,{customer:customerF,clock:F,start:fstart,firstInvoice:prior.firstInvoice});
        let fs=await observe(failed,'F confirmed cancellation reconciled before new effects');
        assert.equal(fs.commitment.paidMinor,301);assert.equal(fs.commitment.reservedMinor,602);assert.equal(fs.commitment.state,'cancellationPending');assert.equal(fs.cycles.length,2);
        assert(fs.cycles.some(c=>c.status==='open'&&c.autoAdvance===false));assert.equal(stripe.counts.activate,1);assert.equal(stripe.counts.advance,7);assert.equal(stripe.counts.cancel,1);
        pass('F completed cancellation observed without repeating it; open invoice retains602 hold');
        const priorInvoices=fs.cycles.map(c=>c.invoice).sort();proof.retryObserved=false;
        await advance(F,fstart+172800+3900);fs=await observe(failed,'F after cancellation final advance');assert.deepEqual(fs.cycles.map(c=>c.invoice).sort(),priorInvoices);assert.equal(fs.commitment.paidMinor,301);assert.equal(fs.commitment.reservedMinor,602);
        await m('harness:control',{token:owner,readonly:false});pass('F final clock advance creates no new invoice or payment; residual invoice remains open');
        const h1=await adopt(customerH,H,goodH,'finite-H');await activate(h1,true);const hstart=contexts.get(h1.id).start;
        for(let n=0;n<4;n++){await advance(H,hstart+n*86400+3900);const hs=await observe(h1,'H1 cycle '+n);assert.equal(hs.commitment.paidMinor,Math.min(n+1,3)*301);if(n===3){assert.equal(hs.commitment.state,'ended');assert.equal(hs.commitment.reservedMinor,0);assert.equal(hs.cycles.length,3);}}
        pass('H1 accepted response loss recovered without recreation; three cycles naturally exhausted');
        const h2=await adopt(customerH,H,goodH,'finite-H');await activate(h2);const h2start=contexts.get(h2.id).start;await advance(H,h2start+3900);let hs=await observe(h2,'H2 first payment');assert.equal(hs.commitment.paidMinor,301);await cancel(h2);await advance(H,h2start+86400+3900);hs=await observe(h2,'H2 after cancellation');assert.equal(hs.commitment.state,'cancelled');assert.equal(hs.commitment.paidMinor,301);assert.equal(hs.cycles.length,1);pass('H2 fresh accepted replacement and cancellation produce one cycle only');
        proof.final=await Promise.all([failed,h1,h2].map(a=>inspect(a.id)));assert.equal(proof.final[0].commitment.state,'cancellationPending');assert.equal(proof.final[0].commitment.reservedMinor,602);assert.equal(proof.final[0].commitment.paidMinor,301);assert(proof.final[0].cycles.some(c=>c.status==='open'&&c.autoAdvance===false));assert(Object.values(stripe.counts).reduce((n,c)=>n+c,0)<=31);assert(proof.final.reduce((n,x)=>n+x.commitment.reservedMinor,0)<=2709);assert(proof.final.reduce((n,x)=>n+x.commitment.paidMinor,0)<=1806);const finalE=await get('/v1/test_helpers/test_clocks',{limit:100},E);assert.equal(finalE.has_more,false);proof.eClockIdsAfter=finalE.data.map(x=>x.id).sort();assert.deepEqual(proof.eClockIdsAfter,proof.eClockIdsBefore);proof.complete=true;proof.remaining=['future-start binding/cancellation','signed durable recurring ingestion','monthly cadence','independent provider readback','full P4/I1/I7 and live financial gates'];save();
    },{resumeDirectory:prior.local.cwd});
} catch(error) {proof.failure=preserveFailure(journal,error);save();console.error('STOP: '+proof.failure.category+'; private diagnostic retained');process.exitCode=1;}
finally {await listener?.stop();save();}
