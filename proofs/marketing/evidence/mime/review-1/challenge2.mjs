import {inspectMime} from '/Users/urkel/Documents/CodeMyVibe/Projects/remold/proofs/marketing/mime.mjs';
import {execFileSync} from 'node:child_process';
const intent='b'.repeat(64),sender='sender@example.invalid',recipient='recipient@example.invalid',px='<img src="http://localhost:3540/email/Trk123.gif">';
const build=({b='abc123',q='',html='<p>Approved html</p>'+px,date='Fri, 25 Sep 2026 01:00:00 +0000',mid='<first@example.invalid>'}={})=>['To: Synthetic <'+recipient+'>','From: Proof <'+sender+'>','Subject: Approved subject','X-Remold-Intent: '+intent,'MIME-Version: 1.0','Date: '+date,'Message-ID: '+mid,'Content-Type: multipart/alternative; boundary='+q+b+q,'','--'+b,'Content-Type: text/plain; charset=utf-8','Content-Transfer-Encoding: quoted-printable','','Approved text','--'+b,'Content-Type: text/html; charset=utf-8','Content-Transfer-Encoding: quoted-printable','',html,'--'+b+'--',''].join('\r\n');
const P=raw=>({intent,raw:Buffer.from(raw,'ascii').toString('base64'),sender,recipient,recipients:1});
const tryI=raw=>{try{return inspectMime(P(raw));}catch{return null;}};
const oracle=raw=>{try{return JSON.parse(execFileSync('python3',['/Users/urkel/Documents/CodeMyVibe/Projects/remold/proofs/marketing/mime-oracle.py'],{input:JSON.stringify(P(raw)),encoding:'utf8',stdio:['pipe','pipe','pipe']}));}catch(e){return {error:String(e.stderr).trim().split('\n').at(-1)};}};
let agree=0,n=0;for(const b of ['abc123','Zz_-9','q'.repeat(70)])for(const q of ['','"']){const r=build({b,q}),j=tryI(r),o=oracle(r);n++;if(j&&o.hash===j.hash)agree++;else console.log('disagree',b,q,o.error);}
console.log('C6 oracle/JS agreement',agree+'/'+n);
const hidden='<p>Approved html</p>'+px+'<!--\r\n--EVIL \r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Unapproved payload</p>'+px+'\r\n-->';
const s=build({html:hidden}),d=build({b:'EVIL',html:hidden,mid:'<retry@x>'});
const os_=oracle(s),od=oracle(d),js=tryI(s),jd=tryI(d);
console.log('C1b JS sealed==dispatched',js.hash===jd.hash,'| oracle sealed',os_.error??('pass, equals JS='+(os_.hash===js.hash)),'| oracle dispatched',od.error??('pass hash='+(od.hash===js.hash)));
const trunc='<p>Approved html</p>'+px+'<!--\r\n--EVIL--\r\n--><p>Required footer</p>';
const od2=oracle(build({b:'EVIL',html:trunc}));console.log('C1c oracle dispatched truncation',od2.error??'pass');
// C3 positions
const raw=build(),bytes=Buffer.from(raw,'ascii'),base=tryI(raw);const dv=[raw.indexOf('Date: ')+6,raw.indexOf('\r\n',raw.indexOf('Date: '))],mv=[raw.indexOf('Message-ID: ')+12,raw.indexOf('\r\n',raw.indexOf('Message-ID: '))];const hits=new Map();
for(let i=0;i<bytes.length;i++){if((i>=dv[0]&&i<dv[1])||(i>=mv[0]&&i<mv[1]))continue;for(const c of [0x20,0x41,0x61,0x2d,0x3d,0x0a,0x09]){if(bytes[i]===c)continue;const m=Buffer.from(bytes);m[i]=c;const v=tryI(m.toString('ascii'));if(v&&v.hash===base.hash){const ctx=JSON.stringify(raw.slice(Math.max(0,i-8),i+4));hits.set(i,(hits.get(i)??'')+String.fromCharCode(c).replace(/\s/,'WS'));}}}
for(const [i,c] of hits)console.log('C3 same-hash at',i,JSON.stringify(raw.slice(Math.max(0,i-10),i))+'^'+JSON.stringify(raw.slice(i,i+3)),'->',c);
