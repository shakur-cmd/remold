import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadSecondStop} from './continuation.mjs';
import {boundedRecurringProvider,D} from './sandbox-policy.mjs';
test('the already cancelled F commitment cannot receive another cancel or card write',async()=>{
 const p=loadSecondStop(),calls=[],raw={request:async(...args)=>{calls.push(args);return{id:'synthetic'};}},provider=boundedRecurringProvider(raw,{wrap:x=>x},p.registry,p.start,p.spent);
 p.registry.commands.set('recurring:repeat-cancel',{kind:'cancel',schedule:p.commitment.schedule});
 p.registry.commands.set('recurring:repeat-card',{kind:'card',subscription:p.commitment.subscription});
 p.registry.paymentMethods.add('pm_fixture');
 await assert.rejects(provider.request('POST','/v1/subscription_schedules/'+p.commitment.schedule+'/cancel',{invoice_now:false,prorate:false},D,'recurring:repeat-cancel'));
 await assert.rejects(provider.request('POST','/v1/subscriptions/'+p.commitment.subscription,{default_payment_method:'pm_fixture'},D,'recurring:repeat-card'));
 assert.equal(calls.length,0);
});
test('the two spent journals leave exactly one F advance and six H advances',async()=>{
 const p=loadSecondStop(),calls=[],raw={request:async(...args)=>{calls.push(args);return{id:'synthetic'};}},provider=boundedRecurringProvider(raw,{wrap:x=>x},p.registry,p.start,p.spent);
 for(const [clock,remaining] of [[p.F,1],[p.H,6]]){for(let n=0;n<remaining;n++){await provider.request('POST','/v1/test_helpers/test_clocks/'+clock.id+'/advance',{frozen_time:clock.time+60},D,clock.label+n);clock.time+=60;}await assert.rejects(provider.request('POST','/v1/test_helpers/test_clocks/'+clock.id+'/advance',{frozen_time:clock.time+60},D,clock.label+'extra'));}
 assert.equal(calls.length,7);assert.equal(provider.counts.advance,14);
});
