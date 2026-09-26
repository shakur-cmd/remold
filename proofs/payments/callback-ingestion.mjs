import {createHash} from 'node:crypto';
// Dependencies are injected so the same code runs against copies with one guard removed.

// Durable ingress: verify, bind to exactly one merchant, store the receipt, only then acknowledge.
export function createReceiver({verify,secret,merchants,ingest}){
 return async(req,res)=>{
  if(req.method!=='POST'||req.url!=='/stripe'){res.writeHead(404).end();return;}
  try{
   const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>1_048_576)throw Error('Body too large');chunks.push(chunk);}
   const raw=Buffer.concat(chunks);
   const event=verify(raw,req.headers['stripe-signature'],secret);
   // The claimed connected account alone picks the tenant. Unknown or missing accounts are refused, not
   // acknowledged, so an event that arrives before its merchant is bound is retried instead of lost.
   const merchant=merchants.find(m=>m.account===event.account);
   if(!merchant)throw Error('Unbound connected account');
   const externalId=event.data?.object?.id;
   if(typeof event.id!=='string'||typeof event.type!=='string'||typeof externalId!=='string')throw Error('Unsupported event shape');
   await ingest(merchant,{eventId:event.id,type:event.type,externalId,digest:createHash('sha256').update(raw).digest('hex')});
   res.writeHead(200).end('accepted');
  }catch{if(!res.destroyed&&!res.headersSent)res.writeHead(400).end('refused');}
 };
}

// Refusals that no retry can change: the event names an object this merchant binding does not own, or its terms differ.
const FINAL=/unbound provider document|currency mismatch|invoice total mismatch|Non-sandbox|No such object/;

// Each pending receipt only triggers a fresh account-scoped provider read; payload state is never applied.
export async function drain({merchants,pending,reconcile,ack,refuse}){
 const outcomes=[];
 for(const merchant of merchants)for(const row of await pending(merchant)){
  try{await reconcile(merchant,row);await ack(merchant,row);outcomes.push({merchant:merchant.name,eventId:row.eventId,result:'applied'});}
  catch(error){
   const reason=FINAL.exec(String(error?.message))?.[0];
   if(reason){await refuse(merchant,row,reason);outcomes.push({merchant:merchant.name,eventId:row.eventId,result:'refused',reason});}
   else outcomes.push({merchant:merchant.name,eventId:row.eventId,result:'retry',reason:String(error?.message).slice(0,200)});
  }
 }
 return outcomes;
}
