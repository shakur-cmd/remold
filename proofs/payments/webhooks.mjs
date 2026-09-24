import{createServer}from'node:http';
import{spawn}from'node:child_process';
import{createHmac,timingSafeEqual,createHash}from'node:crypto';
import{mkdirSync,writeFileSync}from'node:fs';
import{fileURLToPath}from'node:url';
export function verifyStripe(raw,header,secret,now=Date.now()){
 const fields=String(header??'').split(',').map(x=>x.split('='));
 const timestamp=fields.find(([k])=>k==='t')?.[1];
 if(!/^\d+$/.test(timestamp??'')||Math.abs(now/1000-Number(timestamp))>300)throw new Error('Webhook timestamp refused');
 const expected=createHmac('sha256',secret).update(timestamp+'.').update(raw).digest();
 if(!fields.filter(([k])=>k==='v1').some(([,value])=>{const actual=Buffer.from(value??'','hex');return actual.length===expected.length&&timingSafeEqual(actual,expected)}))throw new Error('Webhook signature refused');
 const event=JSON.parse(raw);if(event.livemode!==false)throw new Error('Non-sandbox webhook refused');
 return event;
}
export async function listen(secret,ingest){
 let signingSecret,child;const receipts=[],received=[];
 const privateDir=fileURLToPath(new URL('./private/stripe-cli/',import.meta.url));mkdirSync(privateDir,{recursive:true,mode:0o700});
 const config=privateDir+'config.toml';writeFileSync(config,'',{mode:0o600});
 const server=createServer(async(req,res)=>{
  if(req.method!=='POST'||req.url!=='/stripe'){res.writeHead(404).end();return;}
  try{
   const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>1_048_576)throw new Error('Body too large');chunks.push(chunk)}
   const raw=Buffer.concat(chunks);if(!signingSecret)throw new Error('Listener not ready');
   const event=verifyStripe(raw,req.headers['stripe-signature'],signingSecret);
   const digest=createHash('sha256').update(raw).digest('hex');
   await ingest(event,digest);
   receipts.push({id:event.id,type:event.type,account:event.account??null,apiVersion:event.api_version??null,digest});
   received.push({raw,signature:req.headers['stripe-signature']});
   res.writeHead(200).end('accepted');
  }catch{res.writeHead(400).end('refused');}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(3492,'127.0.0.1',resolve)});
 let readyResolve,readyReject;const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject});
 child=spawn('stripe',['--config',config,'listen','--skip-update','--events','invoice.created,invoice.finalized,invoice.paid,invoice.payment_failed,invoice.voided,credit_note.created,charge.refunded,charge.dispute.created,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted','--forward-to','http://127.0.0.1:3492/stripe','--forward-connect-to','http://127.0.0.1:3492/stripe'],{env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,STRIPE_API_KEY:secret,STRIPE_CLI_TELEMETRY_OPTOUT:'1'},stdio:['ignore','pipe','pipe']});
 let output='';for(const stream of[child.stdout,child.stderr])stream.on('data',chunk=>{output+=chunk;const match=/whsec_[A-Za-z0-9]+/.exec(output);if(match){signingSecret=match[0];output='';readyResolve();}if(output.length>100000)output=output.slice(-1000);});
 child.once('error',()=>readyReject(new Error('Stripe CLI unavailable')));child.once('exit',()=>readyReject(new Error('Stripe CLI exited before readiness')));
 const timer=setTimeout(()=>readyReject(new Error('Stripe CLI readiness timeout')),30_000);
 try{await ready;}catch(error){child.kill();await new Promise(resolve=>server.close(resolve));throw error;}finally{clearTimeout(timer)}
 return{receipts,received,verify:(raw,header,now)=>verifyStripe(raw,header,signingSecret,now),stop:async()=>{child.kill();await new Promise(resolve=>server.close(resolve));received.length=0;signingSecret=undefined;output='';}};
}
