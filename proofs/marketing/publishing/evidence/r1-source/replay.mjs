import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {docker,directory,prefix} from '../runtime.mjs';
import {api} from '../tenants/api.mjs';
import {request} from './http.mjs';
import {formToken} from './server.mjs';
const fixture=JSON.parse(readFileSync(directory+'private/publishing/fixtures.json'));
const output=process.env.REMOLD_PUBLISH_EVIDENCE_DIR??directory+'publishing/evidence/';mkdirSync(output,{recursive:true});
const hash=b=>createHash('sha256').update(b).digest('hex'),hosts={a:'tenant-a.marketing-proof.invalid',b:'tenant-b.marketing-proof.invalid'};
const call=(t,path,options={})=>request(t,{host:hosts[t],path,container:'public',port:8080,...options});
const result={capturedAt:new Date().toISOString(),level:'SERVICE internal public edges plus actual native capture; no DNS/TLS/provider mail',hostChecks:[],pathChecks:[],submissions:[],limits:['Only urlencoded email and firstname forms; no multipart, uploads, native JS, conditional fields, captcha or native actions','Token binds tenant/form/published schema; public token is not abuse prevention','Callback binding, LIVE routing and full P2 remain open','Native page tracking scripts remain in bytes but edge CSP disallows scripts; browser execution not tested','No retries after ambiguous native capture; loss/duplicate recovery not certified']};
const ok=r=>{assert.equal(r.status,200);return r.data;};
const submissions=t=>{const r=ok(api(t,'/forms/'+fixture.tenants[t].formsId+'/submissions?limit=100'));assert.ok(Number(r.total)<100,'Do not truncate the bounded capture inventory');return r;};
const contacts=(t,email)=>Object.values(ok(api(t,'/contacts?limit=100&search='+encodeURIComponent(email))).contacts).filter(c=>c.fields.all.email===email);
const before={a:submissions('a'),b:submissions('b')};const firstContacts={a:ok(api('a','/contacts/1')).contact,b:ok(api('b','/contacts/1')).contact};
const tokens={};
for(const t of ['a','b']){
 const f=fixture.tenants[t],foreign=hosts[t==='a'?'b':'a'];
 for(const [kind,path] of [['form','/form/'+f.formsId],['page','/'+f.publicPageAlias],['asset',new URL(f.assetDownloadUrl).pathname]]){
  const own=call(t,path),wrong=call(t,path,{host:foreign});assert.equal(own.status,200);assert.ok(wrong.status>=400&&wrong.status<500);assert.ok(!wrong.body.toString().includes(fixture.fixture));assert.equal(own.headers['set-cookie'],undefined);assert.equal(own.headers.location,undefined);
  let matchesNative=null;if(kind!=='form'){const native=request(t,{host:hosts[t],path});assert.equal(native.status,200);assert.ok(own.body.equals(native.body),'Published page/asset bytes must equal native bytes');matchesNative=true;}else{tokens[t]=own.body.toString().match(/name="t" value="([a-f0-9]{64})"/)[1];assert.ok(own.body.toString().includes('name="email"'));assert.ok(own.body.toString().includes('name="firstname"'));}
  assert.match(own.headers['content-security-policy'],/default-src 'none'/);result.hostChecks.push({tenant:t,kind,path,ownStatus:own.status,foreignStatus:wrong.status,ownSha256:hash(own.body),matchesNative});
 }
 for(const path of ['/api/contacts','/s/dashboard','/index.php/form/1','/media/files/'+f.filename,'/form/generate.js?id=1','/mtc.js','/mtracking.gif','/form/../1','/form/%2e%2e/1','/form%2f1','//form/1','/form/1/','/Form/1','/form/1;','/form\\1','/form/1?x=1','http://'+hosts[t]+'/form/1']){const r=call(t,path);assert.equal(r.status,404,path);result.pathChecks.push({tenant:t,path,status:r.status});}
 for(const header of ['Forwarded','X-Forwarded-Host','X-Original-URL','X-Rewrite-URL'])assert.equal(call(t,'/form/1',{headers:{[header]:foreign}}).status,400);
 assert.equal(call(t,'/form/1',{rawHeaders:['Host',hosts[t],'Host',hosts[t]]}).status,421,'Duplicate Host must be refused before native capture');
 const otherIp=Object.values(JSON.parse(docker(['inspect',prefix+'-web-'+(t==='a'?'b':'a')]))[0].NetworkSettings.Networks)[0].IPAddress;
 const reach=JSON.parse(docker(['exec',prefix+'-public-'+t,'node','--input-type=module','-e',`try{await fetch('http://'+process.argv[1],{signal:AbortSignal.timeout(2000)});console.log(JSON.stringify({reachable:true}));}catch(e){console.log(JSON.stringify({reachable:false,error:e.cause?.code??e.name}));}`,otherIp]));assert.equal(reach.reachable,false);result['network-'+t]=reach;
}
const email='edge-'+randomUUID()+'@example.invalid';
const send=(t,body,headers={})=>call(t,'/form/1',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',...headers},body});
const body=t=>new URLSearchParams({email,firstname:'Route '+t.toUpperCase(),t:tokens[t]}).toString();
assert.equal(send('b',body('a')).status,403);assert.equal(send('a',body('b')).status,403);
for(const t of ['a','b']){
 const config=JSON.parse(readFileSync(directory+'private/publishing/config-'+t+'.json'));config.form.fields[0].label+=' stale';const stale=new URLSearchParams({email,firstname:'Stale',t:formToken(config)}).toString();
 for(const [candidate,headers] of [[body(t)+'&email=other@example.invalid',{}],[body(t)+'&mauticform%5BformId%5D=2',{}],[body(t)+'&return=https://example.invalid',{}],[body(t)+'&unwanted=1',{}],['email='+encodeURIComponent(email),{}],[stale,{}],[body(t),{'Content-Type':'multipart/form-data; boundary=x'}],[body(t)+'&extra='+'x'.repeat(9000),{}],[body(t),{Origin:'http://'+hosts[t==='a'?'b':'a']}]])assert.ok(send(t,candidate,headers).status>=400);
 assert.deepEqual(submissions(t),before[t],'All refused requests must leave native submissions unchanged');assert.equal(contacts(t,email).length,0);
 const accepted=send(t,body(t),{Cookie:'mtc_id=1; mtc_sid=untrusted',Referer:'http://other.invalid'});assert.equal(accepted.status,200);assert.equal(accepted.body.toString(),'Submission received');assert.equal(accepted.headers['set-cookie'],undefined);assert.equal(accepted.headers.location,undefined);
 const after=submissions(t);assert.equal(Number(after.total),Number(before[t].total)+1);const created=contacts(t,email);assert.equal(created.length,1);assert.equal(created[0].fields.all.firstname,'Route '+t.toUpperCase());assert.deepEqual(ok(api(t,'/contacts/1')).contact,firstContacts[t],'Tracking cookie cannot overwrite the existing contact');
 result.submissions.push({tenant:t,email,contactId:created[0].id,firstname:created[0].fields.all.firstname,before:Number(before[t].total),after:Number(after.total),oldContactUnchanged:true,allNegativeRequestsLeftNoSubmissions:true});
}
assert.notEqual(result.submissions[0].firstname,result.submissions[1].firstname);
result.status='PASS';result.noWorkerRun=true;result.nativePageAndAssetByteComparisons=true;
writeFileSync(output+'replay.json',JSON.stringify(result,null,2)+'\n');console.log('PASS two tenant edges: six host controls, exact paths, token/schema/field refusals, separate actual native captures and unchanged tracked contacts.');
