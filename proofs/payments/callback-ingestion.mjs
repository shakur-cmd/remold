import {createHash} from 'node:crypto';
// Dependencies are injected so the same code runs against copies with one guard removed.
const ACCOUNT=/^acct_[A-Za-z0-9]{1,64}$/;

// Durable ingress: verify, then store before acknowledging. A bound account gets a receipt on its binding;
// a well-formed but unbound account is parked with no effect. Bad signatures and malformed bodies get 400.
export function createReceiver({verify,secret,merchants,ingest,park}){
 return async(req,res)=>{
  if(req.method!=='POST'||req.url!=='/stripe'){res.writeHead(404).end();return;}
  try{
   const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>1_048_576)throw Error('Body too large');chunks.push(chunk);}
   const raw=Buffer.concat(chunks);
   const event=verify(raw,req.headers['stripe-signature'],secret);
   const externalId=event.data?.object?.id;
   if(typeof event.id!=='string'||typeof event.type!=='string'||typeof externalId!=='string')throw Error('Unsupported event shape');
   // Only the signed payload's account picks the tenant; a missing account is not a connected-account event.
   if(typeof event.account!=='string'||!ACCOUNT.test(event.account))throw Error('Connected account required');
   const row={eventId:event.id,type:event.type,externalId,digest:createHash('sha256').update(raw).digest('hex')};
   const merchant=merchants.find(m=>m.account===event.account);
   if(merchant)await ingest(merchant,row);else await park(event.account,row);
   res.writeHead(200).end('accepted');
  }catch{if(!res.destroyed&&!res.headersSent)res.writeHead(400).end('refused');}
 };
}

// Final means no retry can change the answer. Decided from error types and fields, never message text.
export function classify(error){
 if(error&&'requestId' in error&&Number.isInteger(error.status)){
  const status=error.status,code=typeof error.code==='string'?'_'+error.code.toLowerCase().replace(/[^a-z0-9_]/g,'').slice(0,30):'';
  if(status>=400&&status<500&&![408,409,429].includes(status))return{final:true,code:'provider_'+status+code};
  return{final:false,code:'provider_'+status};
 }
 // node:assert failures from the provider client: live-mode or shape refusals.
 if(error?.code==='ERR_ASSERTION')return{final:true,code:'provider_response_refused'};
 return{final:false,code:codeOf(error)};
}
function codeOf(error){const c=error?.name==='ConvexError'?error.data?.code:undefined;return typeof c==='string'&&/^[a-z0-9_]{1,60}$/.test(c)?c:'retryable_error';}

// Each due receipt only triggers a fresh account-scoped provider read; payload state is never applied.
// Failures are isolated per merchant and per receipt.
export async function drain({merchants,due,prepare,reconcile,ack,refuse,defer,now=Date.now,backoffMs=30_000}){
 const outcomes=[];
 for(const merchant of merchants){
  let items;
  try{items=await due(merchant,now());}catch(error){outcomes.push({merchant:merchant.name,result:'merchant_error',code:codeOf(error)});continue;}
  for(const item of items){
   const base={merchant:merchant.name,eventId:item.eventId};
   try{
    const plan=await prepare(merchant,item);
    if(plan.action==='refuse'){await refuse(merchant,item,plan.code);outcomes.push({...base,result:'refused',code:plan.code});continue;}
    let failure=null;
    try{await reconcile(merchant,item);}catch(error){failure=classify(error);}
    if(!failure){await ack(merchant,item);outcomes.push({...base,result:'applied'});}
    else if(failure.final){await refuse(merchant,item,failure.code);outcomes.push({...base,result:'refused',code:failure.code});}
    else{const r=await defer(merchant,item,failure.code,now(),backoffMs);outcomes.push({...base,result:r.state==='failed'?'failed':'retry',code:failure.code,attempts:r.attempts});}
   }catch(error){outcomes.push({...base,result:'item_error',code:codeOf(error)});}
  }
 }
 return outcomes;
}

// Convex wiring shared by the replay and the verifier's attack copy. `client` is a getter so restarts can reconnect.
export function convexDeps({client,api,ingressToken}){
 const m=(f,a)=>client().mutation(f,a),q=(f,a)=>client().query(f,a),c=api.callbackIngestion;
 return{
  ingest:(merchant,row)=>m(api.payments.ingest,{token:merchant.token,binding:merchant.binding,...row}),
  park:(account,row)=>m(c.park,{token:ingressToken,account,...row}),
  due:(merchant,now)=>q(c.due,{token:merchant.token,binding:merchant.binding,now}),
  prepare:(merchant,item)=>q(c.prepare,{token:merchant.token,id:item.id}),
  ack:(merchant,item)=>m(api.payments.ackEvent,{token:merchant.token,id:item.id}),
  refuse:(merchant,item,code)=>m(c.refuse,{token:merchant.token,id:item.id,reason:code}),
  defer:(merchant,item,code,now,backoffMs)=>m(c.defer,{token:merchant.token,id:item.id,code,now,backoffMs}),
 };
}
