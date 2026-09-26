import {inspectMime as NEW} from '/Users/urkel/Documents/CodeMyVibe/Projects/remold/proofs/marketing/mime.mjs';
import {inspectMime as OLD} from '/Users/urkel/Documents/CodeMyVibe/Projects/remold/proofs/marketing/evidence/mime/review-1/mime.mjs';
import {execFileSync} from 'node:child_process';import {randomBytes} from 'node:crypto';import {writeFileSync} from 'node:fs';
const ORACLE='/Users/urkel/Documents/CodeMyVibe/Projects/remold/proofs/marketing/mime-oracle.py';
const intent='c'.repeat(64),sender='synthetic-sender@example.invalid',recipient='recipient@example.invalid',px='<img src=3D"http://localhost:3540/email/Trk123.gif">';
const mid=()=>'<'+randomBytes(16).toString('hex')+'@example.invalid>';
const build=({b='Xq7_randomBoundary',q='"',text='Approved text',html='<p>Approved html</p>'+px,date='Fri, 25 Sep 2026 01:00:00 +0000',id=mid(),ctName='Content-Type'}={})=>['To: Synthetic <'+recipient+'>','From: Synthetic proof <'+sender+'>','Subject: Approved subject','X-Remold-Intent: '+intent,'MIME-Version: 1.0','Date: '+date,'Message-ID: '+id,ctName+': multipart/alternative; boundary='+q+b+q,'','--'+b,'Content-Type: text/plain; charset=utf-8','Content-Transfer-Encoding: quoted-printable','',text,'--'+b,'Content-Type: text/html; charset=utf-8','Content-Transfer-Encoding: quoted-printable','',html,'--'+b+'--',''].join('\r\n');
const P=raw=>({intent,raw:Buffer.from(raw,'ascii').toString('base64'),sender,recipient,recipients:1});
const run=(f,raw)=>{try{return f(P(raw)).hash;}catch{return null;}};
const oracle=raw=>{try{return {hash:JSON.parse(execFileSync('python3',[ORACLE],{input:JSON.stringify(P(raw)),encoding:'utf8',stdio:['pipe','pipe','pipe']})).hash};}catch(e){return {error:String(e.stderr).trim().split('\n').at(-1)};}};
const py=raw=>execFileSync('python3',['-c','import sys,email,email.policy;m=email.message_from_bytes(sys.stdin.buffer.read(),policy=email.policy.default);print(len(list(m.iter_parts())),repr(m.epilogue)[:20])'],{input:Buffer.from(raw,'ascii')}).toString().trim();
const out=[];let bad=0;const rec=(n,ok,d='')=>{out.push({n,ok,d});if(!ok)bad++;console.log((ok?'ok   ':'FAIL ')+n+(d?' :: '+d:''));};
// V0 positive controls (non-vacuity)
const ctl=build(),ctlRetry=build({b:'other_Boundary9',date:'Fri, 25 Sep 2026 01:00:05 +0000'});
rec('V0 sealed control accepted by new JS',!!run(NEW,ctl));rec('V0 sealed control accepted by new oracle, hash equal',oracle(ctl).hash===run(NEW,ctl),JSON.stringify(oracle(ctl)).slice(0,60));
rec('V0 retry control (new boundary/Date/MID, same quoting) same hash',run(NEW,ctl)===run(NEW,ctlRetry)&&!!run(NEW,ctlRetry));
// B1 split-view variants: sealed positive, dispatched variant — old collides, new refuses, oracle refuses, python diverges
const cases={
 'B1a padded delimiter in HTML comment':{html:'<p>Approved html</p>'+px+'<!--\r\n--chosen \r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Other</p>'+px+'\r\n-->'},
 'B1b close delimiter truncates HTML':{html:'<p>Approved html</p>'+px+'<!--\r\n--chosen--\r\n--><p>Required footer</p>'},
 'B1c close delimiter in plain text (native shape)':{text:'Synthetic local proof\r\n--chosen--\r\nRequired footer'},
 'B1d tab-padded delimiter in plain text':{text:'Approved\r\n--chosen\t\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Other</p>'+px}};
for(const [n,o] of Object.entries(cases)){
 const sealed=build(o),disp=build({...o,b:'chosen'});
 const sN=run(NEW,sealed),dN=run(NEW,disp),sO=run(OLD,sealed),dO=run(OLD,disp);
 rec(n+': sealed valid under new JS',!!sN);rec(n+': old normalizer collides',!!sO&&sO===dO,'py sealed='+py(sealed)+' disp='+py(disp));
 rec(n+': new JS refuses dispatched',dN===null);const o2=oracle(disp);rec(n+': new oracle refuses dispatched',!!o2.error,o2.error??'');
}
// B1e case-variant delimiter: does Python treat it as a delimiter? if not, accepting it is fine
{const o={text:'Approved\r\n--CHOSEN--\r\nfooter'};const disp=build({...o,b:'chosen'});rec('B1e case-variant --CHOSEN-- not a parser delimiter (py parts=2, empty epilogue)',py(disp).startsWith('2 '),'py='+py(disp)+' newJS='+(run(NEW,disp)?'accepted':'refused'));}
// B2 volatile header shapes
const b2={'Date phishing text':{date:'Visit https://other.invalid'},'Date folded':{date:'Fri,\r\n 25 Sep 2026 01:00:00 +0000'},'Date double space':{date:'Fri,  25 Sep 2026 01:00:00 +0000'},'Date trailing comment':{date:'Fri, 25 Sep 2026 01:00:00 +0000 (click here)'},
 'MID URL':{id:'<https://other.invalid/'+'a'.repeat(32)+'@example.invalid>'},'MID other domain':{id:'<'+'a'.repeat(32)+'@other.invalid>'},'MID subdomain':{id:'<'+'a'.repeat(32)+'@x.example.invalid>'},'MID uppercase hex':{id:'<'+'A'.repeat(32)+'@example.invalid>'},'MID 31 hex':{id:'<'+'a'.repeat(31)+'@example.invalid>'},'MID trailing text':{id:mid()+' extra'},'MID empty':{id:'<>'}};
for(const [n,o] of Object.entries(b2))rec('B2 refuse '+n,run(NEW,build(o))===null);
// B2 residual accepted shapes (documented channel)
for(const [n,d] of [['weekday mismatch','Mon, 25 Sep 2026 01:00:00 +0000'],['Feb 31','Tue, 31 Feb 2026 01:00:00 +0000'],['year 9999','Fri, 25 Sep 9999 01:00:00 +0000'],['year 0000','Fri, 25 Sep 0000 01:00:00 +0000'],['offset +9999','Fri, 25 Sep 2026 01:00:00 +9999']]){const h=run(NEW,build({date:d}));out.push({n:'B2 residual '+n,ok:true,d:h?'ACCEPTED':'refused'});console.log('info B2 residual '+n+' -> '+(h?'ACCEPTED':'refused')+' Date.parse='+Date.parse(d));}
// header-name case variants of volatile headers fail closed
for(const [n,x] of [['DATE:',build().replace('Date:','DATE:')],['Message-Id:',build().replace('Message-ID:','Message-Id:')]])rec('B2 case variant '+n+' refused (fail-closed)',run(NEW,x)===null);
// C3 single-byte sweep outside boundary tokens and Date/MID value regions
{const raw=build({id:'<'+'d'.repeat(32)+'@example.invalid>'}),base=run(NEW,raw),bytes=Buffer.from(raw,'ascii');let tried=0,acc=0,same=[];for(let i=0;i<bytes.length;i++)for(const c of [0x20,0x41,0x61,0x2d,0x3d,0x30,0x09,0x0a]){if(bytes[i]===c)continue;const m=Buffer.from(bytes);m[i]=c;tried++;const h=run(NEW,m.toString('ascii'));if(h){acc++;if(h===base)same.push(i);}}
 const where=same.map(i=>JSON.stringify(raw.slice(Math.max(0,i-12),i))+'^');rec('C3 single-byte sweep: same-hash only inside Date/MID values',same.every(i=>{const l=raw.lastIndexOf('\r\n',i)+2;return /^(Date|Message-ID): /.test(raw.slice(l,l+12));}),`tried=${tried} accepted=${acc} sameHash=${same.length} ${[...new Set(where.map(w=>w.slice(0,20)))].slice(0,4).join(' ')}`);}
writeFileSync(process.env.T+'/r2-challenge-results.json',JSON.stringify(out,null,2));console.log('FAILURES',bad);
