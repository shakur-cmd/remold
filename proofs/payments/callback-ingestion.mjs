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
// 401/403 describe the platform key or the merchant's access, not the event: they pause reading instead.
export function classify(error){
 if(error&&typeof error==='object'&&'requestId' in error&&Number.isInteger(error.status)){
  const status=error.status,code=typeof error.code==='string'?'_'+error.code.toLowerCase().replace(/[^a-z0-9_]/g,'').slice(0,30):'';
  if(status===401||status===403)return{final:false,pause:status===401?'platform':'merchant',code:'provider_'+status+code};
  if(status>=400&&status<500&&![408,409,429].includes(status))return{final:true,code:'provider_'+status+code};
  return{final:false,code:'provider_'+status};
 }
 // node:assert failures from the provider client: live-mode or shape refusals.
 if(error?.code==='ERR_ASSERTION')return{final:true,code:'provider_response_refused'};
 // A thrown non-Error (string, number, null) is still an attempt: retry it and count it.
 if(!(error instanceof Error))return{final:false,code:'internal_error'};
 return{final:false,code:codeOf(error)};
}
function codeOf(error){const c=error?.name==='ConvexError'?error.data?.code:undefined;return typeof c==='string'&&/^[a-z0-9_]{1,60}$/.test(c)?c:'retryable_error';}

// Each due receipt only triggers a fresh account-scoped provider read; payload state is never applied.
// Failures are isolated per merchant and per receipt. A credential pause stops reading for that merchant,
// or for every merchant when the platform key is the cause; receipts stay open and no attempt is counted.
export async function drain({merchants,admit,due,prepare,reconcile,ack,refuse,defer,pause,resume,now=Date.now,backoffMs=30_000}){
 const outcomes=[];
 for(const merchant of merchants){
  let items;
  try{await admit?.(merchant,now());items=await due(merchant,now());}catch(error){outcomes.push({merchant:merchant.name,result:'merchant_error',code:codeOf(error)});continue;}
  let resumed=false,paused=null;
  for(const item of items){
   const base={merchant:merchant.name,eventId:item.eventId};
   try{
    const plan=await prepare(merchant,item);
    if(plan.action==='refuse'){await refuse(merchant,item,plan.code);outcomes.push({...base,result:'refused',code:plan.code});continue;}
    let failure=null;
    try{await reconcile(merchant,item);}catch(error){failure=classify(error);}
    if(!failure){await ack(merchant,item);outcomes.push({...base,result:'applied'});if(!resumed){resumed=true;await resume?.(merchant).catch(()=>{});}}
    else if(failure.pause){paused=failure.pause;await pause?.(merchant,failure.pause,failure.code).catch(()=>{});outcomes.push({...base,result:'paused',scope:failure.pause,code:failure.code});break;}
    else if(failure.final){await refuse(merchant,item,failure.code);outcomes.push({...base,result:'refused',code:failure.code});}
    else{const r=await defer(merchant,item,failure.code,now(),backoffMs);outcomes.push({...base,result:r.state==='failed'?'failed':'retry',code:failure.code,attempts:r.attempts});}
   }catch(error){outcomes.push({...base,result:'item_error',code:codeOf(error)});}
  }
  if(paused==='platform')break;
 }
 return outcomes;
}

// Re-read invoices left marked incomplete, a bounded batch per merchant, through the same reconcile path.
// `cursors` (merchant name -> last externalId) rotates the batch so permanently failing invoices cannot starve the rest.
export async function sweep({merchants,stale,reconcile,pause,resume,cursors=new Map(),limit=20}){
 const outcomes=[];
 for(const merchant of merchants){
  let batch;
  try{batch=await stale(merchant,cursors.get(merchant.name)??'',limit);cursors.set(merchant.name,batch.next);}catch(error){outcomes.push({merchant:merchant.name,result:'merchant_error',code:codeOf(error)});continue;}
  let resumed=false,paused=null;
  for(const externalId of batch.externalIds){
   const base={merchant:merchant.name,externalId};
   try{
    let failure=null;
    try{await reconcile(merchant,{externalId,eventId:'sweep:'+externalId});}catch(error){failure=classify(error);}
    if(!failure){outcomes.push({...base,result:'completed'});if(!resumed){resumed=true;await resume?.(merchant).catch(()=>{});}}
    else if(failure.pause){paused=failure.pause;await pause?.(merchant,failure.pause,failure.code).catch(()=>{});outcomes.push({...base,result:'paused',scope:failure.pause,code:failure.code});break;}
    else outcomes.push({...base,result:'still_incomplete',code:failure.code});
   }catch(error){outcomes.push({...base,result:'item_error',code:codeOf(error)});}
  }
  if(paused==='platform')break;
 }
 return outcomes;
}

// Convex wiring shared by the replay and the verifier's attack copies. `client` is a getter so restarts can reconnect.
export function convexDeps({client,api,ingressToken}){
 const m=(f,a)=>client().mutation(f,a),q=(f,a)=>client().query(f,a),c=api.callbackIngestion;
 return{
  ingest:(merchant,row)=>m(api.payments.ingest,{token:merchant.token,binding:merchant.binding,...row}),
  park:(account,row)=>m(c.park,{token:ingressToken,account,...row}),
  admit:(merchant,now)=>m(c.admit,{token:merchant.token,binding:merchant.binding,now}),
  due:(merchant,now)=>q(c.due,{token:merchant.token,binding:merchant.binding,now}),
  prepare:(merchant,item)=>q(c.prepare,{token:merchant.token,id:item.id}),
  ack:(merchant,item)=>m(api.payments.ackEvent,{token:merchant.token,id:item.id}),
  refuse:(merchant,item,code)=>m(c.refuse,{token:merchant.token,id:item.id,reason:code}),
  defer:(merchant,item,code,now,backoffMs)=>m(c.defer,{token:merchant.token,id:item.id,code,now,backoffMs}),
  pause:(merchant,scope,code)=>m(c.pause,{token:merchant.token,binding:merchant.binding,scope,code}),
  resume:merchant=>m(c.resume,{token:merchant.token,binding:merchant.binding}),
  stale:(merchant,after,limit)=>q(c.stale,{token:merchant.token,binding:merchant.binding,after,limit}),
 };
}
