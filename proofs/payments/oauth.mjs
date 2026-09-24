import {createServer} from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {credentials,provider,API_VERSION} from './stripe.mjs';
const secret=credentials(),stripe=provider(secret);await stripe.verify();
const clientId='ca_VJwFj4FcjohaD0wjZKB5vJcllH0TPDnD',redirect='http://localhost:3492/stripe/return';
const states=['D','E'].map(label=>({label,state:randomBytes(32).toString('hex'),expires:Date.now()+1800000,status:'pending'}));
const urls=Object.fromEntries(states.map(s=>[s.label,{authorizeURL:'https://connect.stripe.com/oauth/authorize?'+new URLSearchParams({response_type:'code',client_id:clientId,scope:'read_write',redirect_uri:redirect,state:s.state})}]));
const save=()=>writeFileSync(new URL('./private/oauth-state.json',import.meta.url),JSON.stringify(states,null,2),{mode:0o600});save();
writeFileSync(new URL('./private/oauth-authorize.json',import.meta.url),JSON.stringify(urls,null,2),{mode:0o600});
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost:3492');
 const respond=(status,text)=>res.writeHead(status,{'Content-Type':'text/plain','Cache-Control':'no-store','Referrer-Policy':'no-referrer'}).end(text);
 if(req.method!=='GET')return respond(405,'Method refused');
 if(url.pathname==='/stripe/complete')return respond(200,'Sandbox connection received. Return to Remold build session.');
 if(url.pathname!=='/stripe/return')return respond(404,'Route refused');
 const state=url.searchParams.get('state')??'',match=states.find(s=>state.length===s.state.length&&timingSafeEqual(Buffer.from(state),Buffer.from(s.state)));
 if(!match||match.expires<=Date.now()||match.status!=='pending')return respond(400,'Invalid, expired or already consumed state');
 if(url.searchParams.has('error')){match.status='refused';save();return respond(400,'Provider authorization was declined');}
 const code=url.searchParams.get('code');if(!code||!/^ac_[A-Za-z0-9]+$/.test(code))return respond(400,'Invalid authorization code');
 match.status='exchanging';save();
 try{
  // Stripe warns that reusing an OAuth code revokes its connection. Never retry this exchange.
  const response=await fetch('https://connect.stripe.com/oauth/token',{method:'POST',headers:{Authorization:'Basic '+Buffer.from(secret+':').toString('base64'),'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code}),signal:AbortSignal.timeout(30000)});
  const body=await response.json();if(!response.ok||body.livemode!==false||body.scope!=='read_write'||!/^acct_/.test(body.stripe_user_id??''))throw Error('Sandbox OAuth exchange refused');
  writeFileSync(new URL('./private/oauth-'+match.label+'.json',import.meta.url),JSON.stringify(body,null,2),{mode:0o600});
  const account=await stripe.request('GET','/v1/accounts/'+body.stripe_user_id),balance=await stripe.request('GET','/v1/balance',{},body.stripe_user_id);
  if(balance.livemode!==false)throw Error('Non-test account refused');
  const evidence={level:'SANDBOX',apiVersion:API_VERSION,fixture:match.label,account:account.id,type:account.type,controller:account.controller,charges_enabled:account.charges_enabled,payouts_enabled:account.payouts_enabled,capabilities:account.capabilities,requirements:{disabled_reason:account.requirements?.disabled_reason,currently_due:account.requirements?.currently_due,past_due:account.requirements?.past_due},oauthLivemode:body.livemode,balanceLivemode:balance.livemode,scope:body.scope,receipts:stripe.receipts};
  writeFileSync(new URL('./evidence/oauth-'+match.label+'.json',import.meta.url),JSON.stringify(evidence,null,2)+'\n');match.status='connected';match.account=account.id;save();console.log(JSON.stringify(evidence));
  res.writeHead(303,{Location:'/stripe/complete','Cache-Control':'no-store','Referrer-Policy':'no-referrer'}).end();
 }catch{match.status='exchange-or-readback-failed-no-retry';save();respond(400,'Sandbox exchange/readback failed. Code will not be retried.');}
});
server.listen(3492,'127.0.0.1',()=>console.log('Sandbox OAuth receiver ready; D/E URLs private, state single-use.'));
process.on('SIGTERM',()=>server.close());
