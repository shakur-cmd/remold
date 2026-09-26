import assert from 'node:assert/strict';
import {readFileSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {RUN,D,CAPS} from './sandbox-policy.mjs';
export const CONTINUATION = RUN+'-continue-1';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function loadFirstStop() {
    const pinned = (relative,sha) => {const bytes=readFileSync(new URL(relative,import.meta.url));assert.equal(digest(bytes),sha,'First-stop evidence changed: '+relative);return bytes;};
    const journalFile=new URL('./private/'+RUN+'.jsonl',import.meta.url);assert.equal(statSync(journalFile).mode&0o077,0);
    const journalSha='dbe91638bf12d5a3cad2c57e81c17d3a4ae47337ace3ea09e96d42cbfe3d324c';
    const rows=pinned('./private/'+RUN+'.jsonl',journalSha).toString().trim().split('\n').map(JSON.parse);
    const proof=JSON.parse(pinned('../evidence/recurring-sandbox-driver/provider.json','0fd8962a0d894679a51e3d5f07950763669b5c39b521ab57551c995266ad7ace'));
    const local=JSON.parse(pinned('../evidence/recurring-sandbox-driver/local-first-stop.json','b7a6edb935379ce6e72635989c1da9387ffaeabdc9bfa6a2dd909736082a28de'));
    const provider=JSON.parse(pinned('../evidence/recurring-sandbox-driver/first-stop-readback.json','1104b9828b4eefa7d582928fcf0569961c2c57093321498c00e9f15c2dd962cd'));
    pinned('../evidence/recurring-sandbox-driver/first-stop-independent-readback.json','2d4f5ad9f4d9f5b96d8c9ad5179863528fd3b0de98668074dc4574dd331f4d1c');
    assert.equal(rows[0].kind,'started');assert.equal(rows[0].id,RUN);assert.equal(rows[0].sourceAggregate,'848233a23b8b10676b8eb70c0f33682db62cbc7701e40a8d59c25f5e2f0b9baf');assert.equal(proof.run,RUN);assert.equal(proof.complete,false);
    const fixtures=rows.filter(x=>x.kind==='local-fixture');assert.equal(fixtures.length,1);assert.equal(fixtures[0].cwd,local.cwd);assert.equal(local.journalSha256,journalSha);
    const attempts=rows.filter(x=>x.kind==='write-attempt'),responses=rows.filter(x=>x.kind==='write-response');assert.equal(attempts.length,11);assert.equal(responses.length,11);assert(!rows.some(x=>x.kind==='write-error'));
    const counts=Object.fromEntries(Object.keys(CAPS).map(k=>[k,0])),advances=new Map(),keys=[];
    for(const a of attempts){assert.equal(a.method,'POST');assert.equal(a.account,D);assert.equal(a.idempotencyDigest,digest(a.idempotencyKey));const matches=responses.filter(r=>r.sequence===a.sequence);assert.equal(matches.length,1);const r=matches[0];assert.equal(r.receipt.httpStatus,200);assert.equal(r.receipt.idempotencyDigest,a.idempotencyDigest);assert.equal(r.receipt.path,a.path);assert.equal(r.receipt.account,D);keys.push(a.idempotencyKey);
        const kind={'/v1/test_helpers/test_clocks':'clock','/v1/customers':'customer','/v1/products':'product','/v1/prices':'price','/v1/setup_intents':'setup','/v1/subscription_schedules':'activate'}[a.path];
        if(kind)counts[kind]++;else{assert(/^\/v1\/test_helpers\/test_clocks\/[^/]+\/advance$/.test(a.path),'Unrecognized old effect');const id=a.path.split('/')[4];advances.set(id,(advances.get(id)??0)+1);counts.advance++;}
        assert(proof.objects.some(x=>x.id===r.objectId||x.schedule===r.objectId),'Old response missing from owned registry');
    }
    assert.deepEqual(counts,{clock:2,advance:2,customer:2,product:1,price:1,setup:2,activate:1,card:0,cancel:0});assert.deepEqual(proof.counts,counts);assert.equal(new Set(keys).size,11);
    const objects=kind=>proof.objects.filter(x=>x.kind===kind),one=kind=>{const list=objects(kind);assert.equal(list.length,1);return list[0];};
    assert.equal(objects('clock').length,2);assert.equal(objects('customer').length,2);assert.equal(objects('setup-intent').length,2);
    const clocks=new Map(objects('clock').map(c=>{const p=provider.clocks.find(x=>x.id===c.id);assert(p&&p.label===c.label&&p.status==='ready');return[c.id,{id:c.id,label:c.label,time:p.frozenTime,deletesAfter:p.deletesAfter}];}));
    const F=[...clocks.values()].find(c=>c.label==='F'),H=[...clocks.values()].find(c=>c.label==='H');assert(F&&H);assert.equal(F.time,rows[0].start+3960);assert.equal(H.time,rows[0].start);assert.equal(advances.get(F.id),2);assert.equal(advances.has(H.id),false);
    const customerF=objects('customer').find(x=>x.clock===F.id)?.id,customerH=objects('customer').find(x=>x.clock===H.id)?.id;assert(customerF&&customerH&&customerF!==customerH);
    const setupF=objects('setup-intent').find(x=>x.customer===customerF)?.id,setupH=objects('setup-intent').find(x=>x.customer===customerH)?.id;assert(setupF&&setupH);
    const commitment=one('commitment');assert.equal(commitment.local,local.commitment._id);assert.equal(commitment.schedule,local.commitment.schedule);assert.equal(commitment.subscription,local.commitment.subscription);assert.equal(commitment.customer,customerF);assert.equal(local.commitment.state,'active');assert.equal(local.commitment.paidMinor,0);assert.equal(local.commitment.reservedMinor,903);assert.equal(local.commitment.complete,false);assert.equal(local.cycles.length,0);
    const firstInvoice=provider.invoice.id;assert.equal(provider.invoice.customer,customerF);assert.equal(provider.invoice.subscription,commitment.subscription);assert.equal(provider.invoice.amountPaid,301);assert.equal(provider.invoice.status,'paid');
    const registry={clocks,customers:new Set([customerF,customerH]),paymentMethods:new Set(),commands:new Map(),subscriptions:new Set([commitment.subscription]),schedules:new Set([commitment.schedule]),product:one('product').id,price:one('price').id};
    return {journalSha,start:rows[0].start,proof,local,fixture:fixtures[0].fixture,registry,spent:{counts,keys,advances:[...advances]},F,H,customerF,customerH,setupF,setupH,commitment,firstInvoice};
}

export const NEXT_CONTINUATION = RUN+'-continue-2';
export function loadSecondStop() {
    const prior=loadFirstStop();
    const pinned=(relative,sha)=>{const bytes=readFileSync(new URL(relative,import.meta.url));assert.equal(digest(bytes),sha,'Second-stop evidence changed: '+relative);return JSON.parse(bytes);};
    const journalFile=new URL('./private/'+CONTINUATION+'.jsonl',import.meta.url);
    assert.equal(statSync(journalFile).mode&0o077,0);
    const journalSha='8ecfcbbe1ad64ff96cbbf2fb406bd9b7c4f2e9c9a4f9bfdd0ab966d7e712bfaa',bytes=readFileSync(journalFile);
    assert.equal(digest(bytes),journalSha,'Spent continuation journal changed');
    const rows=bytes.toString().trim().split('\n').map(JSON.parse);
    assert.equal(rows[0].id,CONTINUATION);assert.equal(rows[0].parentJournalSha256,prior.journalSha);
    assert.equal(rows[0].sourceAggregate,'65fc2b8d58dc463e8add3de42b9e01c06a4b8513f19b7cdb787013d38011485b');
    const proof=pinned('../evidence/recurring-sandbox-continuation/provider.json','a63163ba6e6112caa6c1051b8e2b58401312e1b4cae54634ad058652093a846f');
    const local=pinned('../evidence/recurring-sandbox-continuation/second-stop-local.json','00cd9d4a3a86e40002910a559cd5c0e043407d5dd5e96971649a3bc5340d7d4f');
    const provider=pinned('../evidence/recurring-sandbox-continuation/second-stop-readback.json','4284dd4ad4d55c974e421237f6d7ee091f6b3a93effe4d02d765f65a2053abe2');
    const independent=pinned('../evidence/recurring-sandbox-continuation/second-stop-independent-readback.json','d480c3158f0cf9f7a0b990d78efb920ea22a4ebbf5844da4de95a6471ef979cb');
    assert.equal(digest(readFileSync(new URL('./private/'+CONTINUATION+'.jsonl.failure.json',import.meta.url))),'954fc750ad998fd01b59f709b11ccf146315713ddd1ac8bed36d5f4c52ccf230','Private failure diagnostic changed');
    assert.equal(digest(readFileSync(new URL('../evidence/recurring-sandbox-continuation/provider-run.txt',import.meta.url))),'922e6cc3bc7ccda76547e094c98289db035807e30c32e1a20b82451f62c84852','Spent run log changed');
    assert.equal(proof.run,CONTINUATION);assert.equal(proof.complete,false);assert.equal(local.cwd,prior.local.cwd);
    const attempts=rows.filter(x=>x.kind==='write-attempt'),responses=rows.filter(x=>x.kind==='write-response');
    assert.equal(attempts.length,10);assert.equal(responses.length,10);assert(!rows.some(x=>x.kind==='write-error'));
    const spent=structuredClone(prior.spent),advances=new Map(spent.advances);
    for(const a of attempts){
        assert.equal(a.method,'POST');assert.equal(a.account,D);assert.equal(a.idempotencyDigest,digest(a.idempotencyKey));assert(!spent.keys.includes(a.idempotencyKey));
        const matches=responses.filter(r=>r.sequence===a.sequence);assert.equal(matches.length,1);const r=matches[0];
        assert.equal(r.receipt.httpStatus,200);assert.equal(r.receipt.idempotencyDigest,a.idempotencyDigest);assert.equal(r.receipt.path,a.path);assert.equal(r.receipt.account,D);spent.keys.push(a.idempotencyKey);
        if(a.path==='/v1/setup_intents'){spent.counts.setup++;assert(proof.objects.some(o=>o.kind==='setup-intent'&&o.id===r.objectId&&o.customer===prior.customerF));}
        else if(a.path==='/v1/subscriptions/'+prior.commitment.subscription){spent.counts.card++;assert.equal(r.objectId,prior.commitment.subscription);assert(local.commands.some(c=>c.kind==='card'&&c.state==='confirmed'&&a.idempotencyKey==='recurring:'+c._id));}
        else if(a.path==='/v1/subscription_schedules/'+prior.commitment.schedule+'/cancel'){spent.counts.cancel++;assert.equal(r.objectId,prior.commitment.schedule);assert(local.commands.some(c=>c.kind==='cancel'&&c.state==='confirmed'&&a.idempotencyKey==='recurring:'+c._id));}
        else {assert.equal(a.path,'/v1/test_helpers/test_clocks/'+prior.F.id+'/advance');assert.equal(r.objectId,prior.F.id);spent.counts.advance++;advances.set(prior.F.id,(advances.get(prior.F.id)??0)+1);}
    }
    assert.deepEqual(spent.counts,{clock:2,advance:7,customer:2,product:1,price:1,setup:4,activate:1,card:2,cancel:1});assert.deepEqual(proof.counts,spent.counts);assert.equal(spent.keys.length,21);spent.advances=[...advances];
    for(const clock of [prior.F,prior.H]){const actual=provider.clocks.find(c=>c.id===clock.id);assert(actual&&actual.status==='ready');assert.equal(actual.label,clock.label);clock.time=actual.frozenTime;clock.deletesAfter=actual.deletesAfter;}
    assert.equal(prior.F.time,prior.start+60+172800-1);assert.equal(prior.H.time,prior.start);
    assert.equal(provider.schedule.id,prior.commitment.schedule);assert.equal(provider.schedule.status,'canceled');assert.equal(provider.subscription.id,prior.commitment.subscription);assert.equal(provider.subscription.status,'canceled');
    assert.equal(local.commitment._id,prior.commitment.local);assert.equal(local.commitment.state,'cancellationPending');assert.equal(local.commitment.cancelRequested,true);assert.equal(local.commitment.paidMinor,301);assert.equal(local.commitment.reservedMinor,602);assert.equal(local.commitment.complete,false);
    assert.equal(local.commands.length,4);assert(local.commands.every(c=>c.state==='confirmed'));assert.equal(local.cycles.length,2);
    assert.deepEqual(local.cycles.map(c=>c.invoice).sort(),provider.invoices.map(i=>i.id).sort());assert.equal(provider.invoices.reduce((n,i)=>n+i.amountPaid,0),301);
    assert(provider.invoices.some(i=>i.status==='open'&&i.amountRemaining===301&&i.autoAdvance===false&&i.nextPaymentAttempt===null));
    prior.registry.readOnlySchedules=new Set([prior.commitment.schedule]);prior.registry.readOnlySubscriptions=new Set([prior.commitment.subscription]);
    prior.registry.schedules.delete(prior.commitment.schedule);prior.registry.subscriptions.delete(prior.commitment.subscription);
    const setupInventory=independent.inventories.filter(i=>i.path==='/v1/setup_intents').map(i=>{assert.equal(i.hasMore,false);return{customer:i.customer,ids:i.rows.map(row=>row.id)};});
    assert.equal(setupInventory.length,2);assert.equal(setupInventory.find(i=>i.customer===prior.customerF)?.ids.length,5);assert.deepEqual(setupInventory.find(i=>i.customer===prior.customerH)?.ids,[prior.setupH]);
    return {...prior,journalSha,parentJournalSha:prior.journalSha,proof,local,spent,setupInventory};
}
