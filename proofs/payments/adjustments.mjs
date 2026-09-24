import assert from 'node:assert/strict';

// Only complete authenticated traversals can authorize further financial capacity.
// Bounds are proof limits; reaching one blocks reconciliation, never truncates it.
export async function pullAdjustments(stripe, invoice, account) {
 assert.ok(Number.isSafeInteger(invoice.total)&&invoice.total>=0,'Invalid invoice total');
 let requests=0;
 const get=async(path,params={})=>{if(++requests>30)throw Error('Adjustment request bound reached');return stripe.request('GET',path,params,account);};
 const list=async(path,params)=>{
  const rows=[],seen=new Set();let cursor;
  for(let page=0;page<5;page++){
   const result=await get(path,{...params,limit:100,...(cursor?{starting_after:cursor}:{})});
   assert.ok(Array.isArray(result.data));assert.equal(typeof result.has_more,'boolean');
   for(const row of result.data){assert.ok(row.id&&!seen.has(row.id),'Repeated provider page identity');seen.add(row.id);rows.push(row);}
   if(!result.has_more)return rows;
   assert.ok(result.data.length,'Empty incomplete provider page');cursor=result.data.at(-1).id;
  }
  throw Error('Adjustment page bound reached');
 };
 const receipts=[],intents=[],seenCharges=new Set();
 const payments=await list('/v1/invoice_payments',{invoice:invoice.id});
 for(const listed of payments){
  const payment=await get('/v1/invoice_payments/'+listed.id);assert.equal(payment.id,listed.id);
  assert.equal(payment.invoice,invoice.id);assert.equal(payment.currency,invoice.currency);assert.equal(payment.livemode,false);assert.ok(['paid','open','canceled'].includes(payment.status),'Unknown invoice payment status');
  assert.equal(payment.payment?.type,'payment_intent','Unsupported invoice payment requires reconciliation');
  const pi=await get('/v1/payment_intents/'+payment.payment.payment_intent);assert.equal(pi.id,payment.payment.payment_intent);assert.equal(pi.livemode,false);assert.equal(pi.currency,invoice.currency);
  if(payment.status!=='paid'){assert.ok(pi.status==='requires_payment_method'||pi.status==='canceled','Unresolved provider payment');continue;}
  assert.equal(pi.status,'succeeded');assert.equal(payment.amount_paid,pi.amount_received,'Partial payment allocation requires reconciliation');
  assert.ok(!intents.includes(pi.id),'Shared payment allocation requires reconciliation');intents.push(pi.id);
  receipts.push({kind:'payment',receiptId:payment.id,sourceRef:pi.id,...(pi.metadata?.remold_command?{operationId:pi.metadata.remold_command}:{}),amountMinor:payment.amount_paid,status:'succeeded'});
  assert.ok(pi.latest_charge);const charge=await get('/v1/charges/'+pi.latest_charge);
  assert.equal(charge.id,pi.latest_charge);assert.equal(charge.payment_intent,pi.id);assert.equal(charge.livemode,false);assert.equal(charge.currency,invoice.currency);
  assert.equal(payment.amount_paid,charge.amount,'Shared or partial charge allocation requires reconciliation');
  assert.ok(!seenCharges.has(charge.id),'Charge shared by invoice payment rows');seenCharges.add(charge.id);
  const refunds=await list('/v1/refunds',{charge:charge.id});let total=0;
  for(const listed of refunds){
   const refund=await get('/v1/refunds/'+listed.id);assert.equal(refund.id,listed.id);
   assert.equal(refund.charge,charge.id);assert.equal(refund.payment_intent,pi.id);assert.equal(refund.currency,invoice.currency);
   assert.ok(['succeeded','failed','canceled','pending','requires_action'].includes(refund.status),'Unknown provider refund status');
   if(refund.status==='succeeded')total+=refund.amount;
   receipts.push({kind:'refund',receiptId:refund.id,sourceRef:charge.id,...(refund.metadata?.remold_operation?{operationId:refund.metadata.remold_operation}:{}),amountMinor:refund.amount,status:refund.status==='canceled'?'cancelled':refund.status==='requires_action'?'pending':refund.status});
  }
  const current=await get('/v1/charges/'+charge.id);assert.equal(current.amount_refunded,total,'Refund traversal changed or incomplete');
 }
 const linkedRefundAmounts=new Map();
 const notes=await list('/v1/credit_notes',{invoice:invoice.id});
 for(const listed of notes){
  const note=await get('/v1/credit_notes/'+listed.id);assert.equal(note.id,listed.id);
  assert.equal(note.invoice,invoice.id);assert.equal(note.currency,invoice.currency);assert.equal(note.livemode,false);assert.ok(['issued','void'].includes(note.status));
  receipts.push({kind:'credit',receiptId:note.id,sourceRef:invoice.id,...(note.metadata?.remold_operation?{operationId:note.metadata.remold_operation}:{}),amountMinor:note.amount,status:note.status==='void'?'cancelled':'succeeded'});
  for(const link of note.refunds??[]){const id=typeof link.refund==='string'?link.refund:link.refund.id;const refund=receipts.find(r=>r.kind==='refund'&&r.receiptId===id);const linked=(linkedRefundAmounts.get(id)??0)+link.amount_refunded;assert.ok(refund&&Number.isSafeInteger(link.amount_refunded)&&link.amount_refunded>0&&linked<=refund.amountMinor,'Credit-note refund link requires exact normalized refund');linkedRefundAmounts.set(id,linked);}
 }
 const current=await get('/v1/invoices/'+invoice.id);
 assert.equal(current.livemode,false);assert.equal(current.currency,invoice.currency);assert.equal(current.total,invoice.total,'Invoice total changed during traversal');assert.equal(current.status,invoice.status,'Invoice state changed during traversal');
 assert.equal(receipts.filter(r=>r.kind==='payment').reduce((n,r)=>n+r.amountMinor,0),current.amount_paid,'Payment traversal changed or incomplete');assert.equal(current.amount_paid,invoice.amount_paid,'Invoice changed during traversal');
 const refundedMinor=receipts.filter(r=>r.kind==='refund'&&r.status==='succeeded').reduce((n,r)=>n+r.amountMinor,0);
 const creditedMinor=receipts.filter(r=>r.kind==='credit'&&r.status==='succeeded').reduce((n,r)=>n+r.amountMinor,0);
 assert.equal(creditedMinor,current.pre_payment_credit_notes_amount+current.post_payment_credit_notes_amount,'Credit traversal changed or incomplete');
 assert.ok(receipts.length<=500,'Adjustment receipt bound reached');
 return{receipts,refundedMinor,creditedMinor,intents,requests};
}
