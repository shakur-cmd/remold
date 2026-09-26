import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, renameSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { OAuthConnections, CALLBACK, MAILBOXES } from './oauth.mjs';
const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'../..');
const credentialPath=join(root,'.env.remold-sandbox.local');
if((statSync(credentialPath).mode&0o777)!==0o600)throw new Error('Credential file must be0600');
const env=Object.fromEntries(readFileSync(credentialPath,'utf8').split(/\r?\n/).filter(s=>/^GOOGLE_[A-Z_]+=/.test(s)).map(s=>{const i=s.indexOf('=');return[s.slice(0,i),s.slice(i+1).replace(/^(["'])(.*)\1$/,'$2')]}));
if(!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || env.GOOGLE_PROJECT_ID!=='remold-integrations-staging')throw new Error('Isolated Google staging credentials required');
const calendarProof=process.env.P5_CALENDAR_PROOF==='1';
let existing={};
if(calendarProof){
 const prior=JSON.parse(readFileSync(join(here,'evidence/oauth-ready.json'),'utf8'));
 const path=join(prior.privateDirectory,'mailbox-A.json');
 if((statSync(path).mode&0o777)!==0o600)throw new Error('PRIVATE_STORE_MODE');
 existing={A:JSON.parse(readFileSync(path,'utf8'))};
 if(existing.A.email!==MAILBOXES.A)throw new Error('PRIVATE_STORE_ACCOUNT');
}
const privateDir=mkdtempSync(join(tmpdir(),'remold-communications-'));
const auth=new OAuth2Client(env.GOOGLE_CLIENT_ID,env.GOOGLE_CLIENT_SECRET,CALLBACK);
const sessions=new Map(),safeResults={};
if(calendarProof){writeFileSync(join(privateDir,'mailbox-A.json'),JSON.stringify(existing.A),{mode:0o600});}
const privateWrite=(name,value)=>{const path=join(privateDir,name);writeFileSync(path+'.tmp',JSON.stringify(value),{mode:0o600});renameSync(path+'.tmp',path)};
const stage=async(name,operation)=>{try{return await operation()}catch(error){
  const data=error?.response?.data?.error;
  const reasons=[data?.status,...(Array.isArray(data?.errors)?data.errors.map(item=>item?.reason):[])].filter(value=>typeof value==='string'&&/^[A-Za-z0-9_]{1,80}$/.test(value));
  const status=error?.response?.status;
  writeFileSync(join(here,'evidence/oauth-failure.json'),JSON.stringify({at:new Date().toISOString(),stage:name,httpStatus:Number.isInteger(status)?status:null,reasons,rawProviderResponseRecorded:false,credentialsRecorded:false},null,2)+'\n');
  throw new Error('OAUTH_FAILED');
}};
const flow=new OAuthConnections({clientId:env.GOOGLE_CLIENT_ID,calendarProof,existing,
  exchange:async(code,codeVerifier)=>stage('token_exchange',async()=>(await auth.getToken({code,codeVerifier,redirect_uri:CALLBACK})).tokens),
  verify:async idToken=>stage('id_token_verification',async()=>(await auth.verifyIdToken({idToken,audience:env.GOOGLE_CLIENT_ID})).getPayload()),
  profile:async tokens=>stage('gmail_profile',async()=>{const c=new OAuth2Client(env.GOOGLE_CLIENT_ID,env.GOOGLE_CLIENT_SECRET,CALLBACK);c.setCredentials(tokens);return(await c.request({url:'https://gmail.googleapis.com/gmail/v1/users/me/profile',method:'GET'})).data}),
  persistCandidate:async candidate=>privateWrite(`candidate-${candidate.slot}.json`,candidate),
  persist:async connection=>privateWrite(`mailbox-${connection.slot}.json`,connection),
});
const base='http://127.0.0.1:3522';
const cookie=req=>/p5_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie??'')?.[1];
const purpose=calendarProof?'Add calendar permission for one labeled no-guests primary-calendar event: create, reschedule, then delete. Connection alone makes no event.':'Connect Envoylogic for the approved reciprocal test (maximum five messages per mailbox per day). Gmail read and send permissions are requested. This connection step sends nothing. No calendar access or historical mailbox import.';
const html=body=>`<!doctype html><html><meta charset="utf-8"><title>Remold mailbox proof</title><style>body{font:17px system-ui;max-width:680px;margin:60px auto;padding:20px}button{padding:12px}section{margin:24px 0}</style><h1>Connect test mailboxes</h1><p>${purpose}</p>${body}</html>`;
const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://accounts.google.com; base-uri 'none'; frame-ancestors 'none'");
  try{
    if(req.headers.host!=='127.0.0.1:3522')throw new Error('INVALID_HOST');
    const url=new URL(req.url,base);
    if(req.method==='GET' && url.pathname==='/health'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ready:true,sendAllowance:0,calendarConsentMode:calendarProof,calendarAuthorized:safeResults.A?.calendarAuthorized===true,connected:Object.keys(safeResults)}));return}
    if(req.method==='GET' && url.pathname==='/'){
      // HTML POST needs a real same-origin Origin; callbacks retain no-referrer.
      res.setHeader('Referrer-Policy','same-origin');
      let id=cookie(req);if(!sessions.has(id)){if(sessions.size>20)sessions.clear();id=randomBytes(32).toString('base64url');sessions.set(id,{csrf:randomBytes(32).toString('base64url'),at:Date.now()});}
      res.setHeader('Set-Cookie',`p5_session=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600`);res.setHeader('Content-Type','text/html; charset=utf-8');
      res.end(html(Object.entries(MAILBOXES).filter(([slot])=>slot==='A').map(([slot,email])=>`<section><p>${email}: ${safeResults[slot]?'Connected for reviewed test':'Not connected'}</p><form method="post" action="/connect"><input type="hidden" name="slot" value="${slot}"><input type="hidden" name="csrf" value="${sessions.get(id).csrf}"><button>Connect ${slot}</button></form></section>`).join('')+'<p>reply@repliedfor.com uses Purelymail; its separate TLS connection check passed. It is not a second Google mailbox.</p>'));return;
    }
    if(req.method==='POST' && url.pathname==='/connect'){
      const id=cookie(req),session=sessions.get(id);
      if(req.headers.origin!==base || !session || Date.now()-session.at>3600000){
        writeFileSync(join(here,'evidence/local-form-diagnostic.json'),JSON.stringify({at:new Date().toISOString(),originMatches:req.headers.origin===base,originMissing:req.headers.origin===undefined,originIsNull:req.headers.origin==='null',hasSessionCookie:!!id,hasMatchingSession:!!session,sessionExpired:!!session&&Date.now()-session.at>3600000,fetchSite:['same-origin','same-site','cross-site','none'].includes(req.headers['sec-fetch-site'])?req.headers['sec-fetch-site']:'other',fetchMode:['navigate','cors','no-cors'].includes(req.headers['sec-fetch-mode'])?req.headers['sec-fetch-mode']:'other',fetchDestination:req.headers['sec-fetch-dest']==='document'?'document':'other',credentialValuesRecorded:false},null,2)+'\n');
        throw new Error('INVALID_SESSION');
      }
      let body='';for await(const chunk of req){body+=chunk;if(body.length>2048)throw new Error('BODY_TOO_LARGE')}
      const fields=new URLSearchParams(body);if(fields.get('csrf')!==session.csrf)throw new Error('INVALID_CSRF');
      res.writeHead(303,{Location:flow.begin(fields.get('slot'),id)});res.end();return;
    }
    if(req.method==='GET' && url.pathname==='/oauth/google/callback'){
      const result=await flow.complete({state:url.searchParams.get('state'),code:url.searchParams.get('code'),error:url.searchParams.get('error'),session:cookie(req)});
      safeResults[result.slot]={...result,level:'LIVE OAuth/profile only; fixture tenant/member',at:new Date().toISOString()};
      mkdirSync(join(here,'evidence'),{recursive:true});writeFileSync(join(here,'evidence/oauth-results.json'),JSON.stringify(safeResults,null,2)+'\n');
      res.writeHead(303,{Location:'/'});res.end();return;
    }
    res.writeHead(404);res.end('Not found');
  }catch(error){const safe=/^[A-Z_]+$/.test(error?.message??'')?error.message:'OAUTH_FAILED';res.writeHead(400,{'Content-Type':'text/html; charset=utf-8'});res.end(html(`<p>Connection refused: ${safe}. Return to the start page to try again.</p><a href="/">Return</a>`));}
});
server.listen(3522,'127.0.0.1',()=>{
  writeFileSync(join(here,'evidence/oauth-ready.json'),JSON.stringify({callback:CALLBACK,origin:base,privateDirectory:privateDir,credentialMode:'0600',sendAllowance:0,calendarConsentMode:calendarProof,calendarAuthorized:false,oauthLiveVerified:false},null,2)+'\n');
  console.log('P5 OAuth callback ready at '+base+'; no sends or calendar writes.');
});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));
