import {inspectMime} from '/Users/urkel/Documents/CodeMyVibe/Projects/remold/proofs/marketing/mime.mjs';
import {createSink} from '/Users/urkel/Documents/CodeMyVibe/Projects/remold/proofs/marketing/mime-sink.mjs';
import {writeFileSync,mkdtempSync} from 'node:fs';import {execFileSync} from 'node:child_process';import {join} from 'node:path';
const T=process.env.T,intent='b'.repeat(64),sender='sender@example.invalid',recipient='recipient@example.invalid';
const out=[];const rec=(name,ok,detail='')=>{out.push({name,result:ok?'AS-EXPECTED':'FINDING',detail});console.log((ok?'ok   ':'FIND ')+name+(detail?' :: '+detail:''));};
const build=({b='abc123',date='Fri, 25 Sep 2026 01:00:00 +0000',mid='<first@example.invalid>',text='Approved text',html='<p>Approved html</p>',extra=[],ct=null}={})=>['To: Synthetic <'+recipient+'>','From: Proof <'+sender+'>','Subject: Approved subject','X-Remold-Intent: '+intent,'MIME-Version: 1.0','Date: '+date,'Message-ID: '+mid,...extra,ct??('Content-Type: multipart/alternative; boundary='+b),'','--'+b,'Content-Type: text/plain; charset=utf-8','Content-Transfer-Encoding: quoted-printable','',text,'--'+b,'Content-Type: text/html; charset=utf-8','Content-Transfer-Encoding: quoted-printable','',html,'--'+b+'--',''].join('\r\n');
const P=raw=>({intent,raw:Buffer.from(raw,'ascii').toString('base64'),sender,recipient,recipients:1});
const tryI=raw=>{try{return inspectMime(P(raw));}catch{return null;}};
const oracle=raw=>{try{return JSON.parse(execFileSync('python3',['/Users/urkel/Documents/CodeMyVibe/Projects/remold/proofs/marketing/mime-oracle.py'],{input:JSON.stringify(P(raw)),encoding:'utf8',stdio:['pipe','pipe','pipe']}));}catch(e){return {error:String(e.stderr).trim().split('\n').at(-1)};}};
const pyparts=raw=>execFileSync('python3',['-c',`import sys,email,email.policy;m=email.message_from_bytes(sys.stdin.buffer.read(),policy=email.policy.default);print([ (p.get_content_type(), p.get_content().strip()[:60]) for p in m.iter_parts()], len(m.defects))`],{input:Buffer.from(raw,'ascii')}).toString().trim();

// C1 boundary-swap split-view collision: approved HTML hides a padded delimiter for a different boundary inside a comment.
const hidden='<p>Approved html</p><!--\r\n--EVIL \r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Unapproved payload</p>\r\n-->';
const sealed=build({b:'abc123',html:hidden}),dispatched=build({b:'EVIL',html:hidden,date:'Fri, 25 Sep 2026 02:00:00 +0000',mid:'<retry@example.invalid>'});
const s=tryI(sealed),d=tryI(dispatched);
rec('C1 boundary-swap same normalized hash with different MIME structure',!(s&&d&&s.hash===d.hash),s&&d?`hash equal=${s.hash===d.hash}; python sealed parts=${pyparts(sealed)} | dispatched parts=${pyparts(dispatched)}`:'rejected');
const oS=oracle(sealed),oD=oracle(dispatched);rec('C1b repo Python oracle on dispatched bytes',!!oD.error,'sealed:'+(oS.error??'pass')+' dispatched:'+(oD.error??'pass hash='+oD.hash));
// C1c close-delimiter truncation variant
const trunc='<p>Approved html</p><!--\r\n--EVIL--\r\n--><p>Required legal footer</p>';
const s2=tryI(build({html:trunc})),d2=tryI(build({b:'EVIL',html:trunc}));
rec('C1c boundary-swap close-delimiter truncation',!(s2&&d2&&s2.hash===d2.hash),s2&&d2?`hash equal=${s2.hash===d2.hash}; python dispatched parts=${pyparts(build({b:'EVIL',html:trunc}))}`:'rejected');
// C2 unhashed Date/Message-ID carry arbitrary content
const base=tryI(build());
for(const [n,o] of [['Date text',{date:'Urgent: verify your account at http://phish.invalid'}],['Message-ID text',{mid:'<click-http://phish.invalid-now@x>'}],['Date folded 2KB',{date:'Fri,\r\n '+'x'.repeat(2000)}],['Message-ID empty',{mid:''}]]){const v=tryI(build(o));rec('C2 '+n+' excluded from hash',!(v&&v.hash===base.hash),v?'accepted, same hash='+(v.hash===base.hash):'rejected');}
// C3 exhaustive single-byte mutation sweep (outside Date/Message-ID values and boundary tokens)
{const raw=build();const bytes=Buffer.from(raw,'ascii');const dateV=[raw.indexOf('Date: ')+6,raw.indexOf('\r\n',raw.indexOf('Date: '))],midV=[raw.indexOf('Message-ID: ')+12,raw.indexOf('\r\n',raw.indexOf('Message-ID: '))];
 let tried=0,collide=[],accepted=0;for(let i=0;i<bytes.length;i++){if((i>=dateV[0]&&i<dateV[1])||(i>=midV[0]&&i<midV[1]))continue;for(const c of [0x20,0x41,0x61,0x2d,0x3d,0x0a,0x09]){if(bytes[i]===c)continue;const m=Buffer.from(bytes);m[i]=c;tried++;const v=tryI(m.toString('ascii'));if(v){accepted++;if(v.hash===base.hash)collide.push(i);}}}
 // boundary-token positions are allowed to collide only if all occurrences change together; a single-byte change breaks structure
 rec('C3 single-byte mutation sweep',collide.length===0,`tried=${tried} acceptedVariants=${accepted} sameHash=${collide.length}`);}
// C4 header shape probes
for(const [n,raw,expect] of [
 ['Resent-Bcc header accepted (hashed)',build({extra:['Resent-Bcc: hidden@example.invalid']}),'accept'],
 ['lowercase duplicate to',build({extra:['to: other@example.invalid']}),'reject'],
 ['BOUNDARY uppercase param',build({ct:'Content-Type: multipart/alternative; BOUNDARY=abc123'}),'any'],
 ['8-bit byte',build({text:'café'}).replace(/[^\x00-\x7f]/,'\x80'),'reject'],
 ['bare LF',build().replace('Approved text','Approved\ntext'),'reject'],
 ['preamble',build().replace('\r\n\r\n--abc123','\r\n\r\npreamble\r\n--abc123'),'reject'],
 ['top-level CTE header',build({extra:['Content-Transfer-Encoding: base64']}),'accept'],
 ['folded To with second address',build().replace('To: Synthetic <'+recipient+'>','To: Synthetic <'+recipient+'>,\r\n other@example.invalid'),'reject'],
]){const v=tryI(raw);rec('C4 '+n,expect==='any'||(expect==='accept')===!!v,v?'accepted':'rejected');}
// C4b BOUNDARY uppercase: hash must not vary silently with boundary (liveness only)
{const a=tryI(build({ct:'Content-Type: multipart/alternative; BOUNDARY=abc123'})),b=tryI(build({b:'zz9',ct:'Content-Type: multipart/alternative; BOUNDARY=zz9'}));rec('C4b uppercase BOUNDARY param stable across retries',!!(a&&b&&a.hash===b.hash),a&&b?'hash equal='+(a.hash===b.hash)+' (fails closed: retry would be held)':'rejected');}
// C5 changed-variant through the real receiver + concurrent duplicate POST
{const dir=mkdtempSync(join(T,'sink-')),key='k'.repeat(40),sink=createSink({key,sender,recipient},join(dir,'s.sqlite'));await new Promise(r=>sink.server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+sink.server.address().port;
 const post=(body,k=key)=>fetch(url+'/deliver',{method:'POST',headers:{'x-remold-sink-key':k},body:JSON.stringify(body)}).then(r=>r.status);
 const good=P(build()),exp=inspectMime(good).hash;
 rec('C5 wrong key 403',await post({...good,expected:exp},'x'.repeat(40))===403);
 rec('C5 boundary-swap variant with approved hash accepted by receiver',(await post({...P(dispatched),expected:s.hash}))!==200,'receiver would store split-view bytes under approved hash');
 const dir2=mkdtempSync(join(T,'sink2-')),sink2=createSink({key,sender,recipient},join(dir2,'s.sqlite'));await new Promise(r=>sink2.server.listen(0,'127.0.0.1',r));const url2='http://127.0.0.1:'+sink2.server.address().port;
 const st=await Promise.all(Array.from({length:8},(_,i)=>fetch(url2+'/deliver',{method:'POST',headers:{'x-remold-sink-key':key},body:JSON.stringify({...P(build({b:'b'+i,mid:'<m'+i+'@x>'})),expected:exp})}).then(r=>r.status)));
 const n=sink2.db.prepare('SELECT COUNT(*) n FROM deliveries').get().n;rec('C5 8 concurrent retry-variant POSTs store exactly one',n===1&&st.filter(x=>x===200).length===1,'statuses='+st.join(',')+' rows='+n);
 rec('C5 oversize 413',await fetch(url2+'/deliver',{method:'POST',headers:{'x-remold-sink-key':key},body:'x'.repeat(70000)}).then(r=>r.status).catch(()=>'reset')!==200);
 sink.server.close();sink2.server.close();}
// C6 oracle agreement on accepted retry variants
{let agree=0,n=0;for(const b of ['abc123','Zz_-9',"q".repeat(70)]){for(const q of ['','"']){const raw=build({b,ct:'Content-Type: multipart/alternative; boundary='+q+b+q});const j=tryI(raw),o=oracle(raw);n++;if(j&&o.hash===j.hash)agree++;}}rec('C6 oracle/JS hash agreement on quoted+unquoted boundary variants',agree===n,agree+'/'+n);}
writeFileSync(join(T,'challenge-results.json'),JSON.stringify(out,null,2));
