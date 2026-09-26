import {test} from 'node:test';
import assert from 'node:assert/strict';
import {settledCancellation} from './settled-cancellation.mjs';
const snapshot=(autoAdvance,revision=1)=>({schedule:{id:'sched',status:'canceled',revision},subscription:{id:'sub',status:'canceled'},invoice:{id:'invoice',auto_advance:autoAdvance,next_payment_attempt:autoAdvance?123:null,hosted_invoice_url:null,invoice_pdf:null}});
test('cancellation waits through real invoice and schedule changes and accepts rotating delivery links',async()=>{
 const values=[snapshot(true),snapshot(false),snapshot(false,2),snapshot(false,2)];let reads=0;
 const result=await settledCancellation(async()=>{const row=values[reads++];row.invoice.hosted_invoice_url='https://example.invalid/'+reads;return row;},async()=>{});
 assert.equal(reads,4);assert.equal(result.invoice.auto_advance,false);assert.equal(result.schedule.revision,2);
});
test('unsettled cancellation stops after eight reads instead of widening financial equality',async()=>{
 let reads=0;await assert.rejects(settledCancellation(async()=>snapshot(reads++%2===0),async()=>{}),/eight reads/);assert.equal(reads,8);
});
