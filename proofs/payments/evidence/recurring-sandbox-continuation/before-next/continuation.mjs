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
