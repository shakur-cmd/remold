// IV r2 attack 1: with the round-1 D1 edit live on the old native intake forms, send raw-socket header, path,
// nonce, token and body attacks through the deployed edges. Mautic must not move; only expected captures appear.
import {readFileSync} from 'node:fs';
import * as L from './lib2.mjs';
const fixtures=JSON.parse(readFileSync(L.directory+'private/publishing/fixtures.json')),out={tenants:{},crossTenant:null};
const shared=L.nonce();
for(const t of ['a','b']){
 const formId=fixtures.tenants[t].intakeFormsId,other=t==='a'?'b':'a',H=L.host(t);
 const owner=L.makeOwner(t,'r2edge'),p0=L.profile(t,owner.id),m0=L.mautic(t),inv0=await L.inventory(t);
 const edit=L.d1Edit(t,formId);
 const n=L.nonce,E=owner.email,B=(f,nn,tok)=>L.body(t,E,f,nn,tok);
 const replayN=n(),conflictN=n();
 const long='x'.repeat(250)+'@e.io';
 const cases=[
  // expected status, expected new stored captures
  ['duplicate Cookie headers',L.P(t,B('dup',n()),'Cookie: mtc_id='+owner.id+'\r\nCookie: Blocked-Tracking=0\r\n'),'200',1],
  ['lowercase cookie, DNT 0, Sec-GPC 0',L.P(t,B('lower',n()),'cookie: Blocked-Tracking=0\r\nDNT: 0\r\nSec-GPC: 0\r\n'),'200',1],
  ['obs-fold continuation',L.P(t,B('fold',n()),'Cookie: a=b\r\n Blocked-Tracking=0\r\n'),'400',0],
  ['X-Forwarded-Host',L.P(t,B('xfh',n()),'X-Forwarded-Host: evil.invalid\r\n'),'400',0],
  ['mauticform key in body',L.P(t,B('mf',n())+'&mauticform%5Bemail%5D=x%40e.io'),'400',0],
  ['CRLF in firstname',L.P(t,B('a\r\nX: y',n())),'400',0],
  ['missing nonce',L.P(t,new URLSearchParams({email:E,firstname:'nonon',t:L.token(t)}).toString()),'400',0],
  ['upper-case nonce',L.P(t,B('upper',n().toUpperCase())),'400',0],
  ['31-hex nonce',L.P(t,B('short',n().slice(1))),'400',0],
  ['33-hex nonce',L.P(t,B('long',n()+'a')),'400',0],
  ['duplicate nonce key',L.P(t,B('dupn',n())+'&n='+n()),'400',0],
  ['forged client nonce (all zero)',L.P(t,B('zero-'+L.run,'0'.repeat(32))),'200',1],
  ['fresh nonce, first post',L.P(t,B('replay',replayN)),'200',1],
  ['same body replayed',L.P(t,B('replay',replayN)),'200',0],
  ['same nonce, first post for conflict',L.P(t,B('orig',conflictN)),'200',1],
  ['same nonce, changed firstname',L.P(t,B('changed',conflictN)),'409',0],
  ['same nonce, changed email',L.P(t,L.body(t,'other-'+L.run+'@example.invalid','orig',conflictN)),'409',0],
  ['nonce shared with the other tenant',L.P(t,B('shared',shared)),'200',1],
  ['other tenant token',L.P(t,B('xtok',n(),L.token(other))),'403',0],
  ['missing token',L.P(t,new URLSearchParams({email:E,firstname:'x',n:n()}).toString()),'400',0],
  ['other tenant Host',L.P(t,B('xhost',n())).replace('Host: '+H,'Host: '+L.host(other)),'421',0],
  ['oversized Content-Length',L.P(t,B('big',n())).replace(/Content-Length: \d+/,'Content-Length: 9000'),'413',0],
  ['chunked oversized',`POST /form/intake HTTP/1.1\r\nHost: ${H}\r\nContent-Type: application/x-www-form-urlencoded\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n2328\r\n${'a='+'x'.repeat(8998)}\r\n0\r\n\r\n`,'413',0],
  ['invalid UTF-8',P2(t,B('ux',n()).replace('firstname=ux','firstname=u\xff')),'400',0],
  ['bad percent encoding',L.P(t,B('pct',n())+'%zz'),'400',0],
  ['multipart',L.P(t,B('mp',n())).replace('application/x-www-form-urlencoded','multipart/form-data; boundary=x'),'415',0],
  ['urlencoded with charset',L.P(t,B('cs',n())).replace('application/x-www-form-urlencoded','application/x-www-form-urlencoded; charset=utf-8'),'415',0],
  ['JSON body',L.P(t,JSON.stringify({email:E})).replace('application/x-www-form-urlencoded','application/json'),'415',0],
  ['255-char email',L.P(t,L.body(t,'y'+long,'x',n())),'400',0],
  ['101-char firstname',L.P(t,B('z'.repeat(101),n())),'400',0],
  ['email without dot',L.P(t,L.body(t,'a@b','x',n())),'400',0],
  ...['/form/intake/','/form/intake?x=1','//form/intake','/form/%69ntake','/FORM/intake','/form/intake/../intake','http://'+H+'/form/intake','/form/1','/form/'+formId,'/form/submit?formId='+formId+'&ajax=1'].map(p=>['path '+p,L.P(t,B('path',n()),'',p),'404',0]),
  ['PUT on form path',L.P(t,B('put',n())).replace(/^POST/,'PUT'),'404',0],
 ];
 function P2(t,latin){return L.P(t,latin).replace(/Content-Length: \d+/,'Content-Length: '+Buffer.byteLength(latin,'latin1'));}
 const results=L.rawRequests(t,cases.map(c=>c[1]));
 const rows=cases.map((c,i)=>({kind:c[0],expected:c[2],statuses:results[i].statuses,error:results[i].error,match:results[i].statuses.join(',')===c[2]}));
 const inv1=await L.inventory(t),added=inv1.filter(c=>!inv0.some(o=>o.id===c.id)),m1=L.mautic(t),p1=L.profile(t,owner.id),revert=L.d1Revert(t,formId);
 const expectedAdded=cases.reduce((s,c)=>s+c[3],0);
 out.tenants[t]={formId,ownerId:owner.id,d1Edit:edit,d1Revert:revert,rows,addedCaptures:added.map(c=>({idempotencyKey:c.idempotencyKey,firstname:c.firstname,tenant:c.tenant})),mauticBefore:m0,mauticAfter:m1,ownerBefore:p0,ownerAfter:p1,
  verdict:{allAsExpected:rows.every(r=>r.match),addedEqualsExpected:added.length===expectedAdded,allOwnTenant:added.every(c=>c.tenant===t),conflictKeptOriginal:inv1.find(c=>c.idempotencyKey===conflictN)?.firstname==='orig',mauticUnchanged:JSON.stringify(m0)===JSON.stringify(m1),ownerUnchanged:JSON.stringify(p0)===JSON.stringify(p1)}};
 console.log(t,JSON.stringify(rows.filter(r=>!r.match)),JSON.stringify(out.tenants[t].verdict),added.length,expectedAdded);
}
out.crossTenant={sharedNonce:shared,a:(await L.inventory('a')).filter(c=>c.idempotencyKey===shared).map(c=>c.firstname),b:(await L.inventory('b')).filter(c=>c.idempotencyKey===shared).map(c=>c.firstname)};
console.log('shared nonce',JSON.stringify(out.crossTenant));
L.save2('b1-edge-attacks',out);
