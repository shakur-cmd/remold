import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inspectMime} from './mime.mjs';
import {payload} from './mime-fixture.mjs';
const sender='sender@example.invalid',recipient='recipient@example.invalid';
const change=(p,from,to)=>({...p,raw:Buffer.from(Buffer.from(p.raw,'base64').toString().replace(from,to)).toString('base64')});
test('only Date, Message-ID and the one multipart boundary may vary across attempts',()=>{
 const a=inspectMime(payload()),b=inspectMime(payload({boundary:'different',date:'Fri, 25 Sep 2026 02:00:00 +0000',id:'second'}));assert.equal(a.hash,b.hash);assert.notEqual(a.rawSha256,b.rawSha256);
 for(const update of [{subject:'Changed subject'},{text:'Changed text'},{html:'<p>Changed html</p>'},{text:'ordinary abc123 boundary text'}])assert.notEqual(inspectMime(payload(update)).hash,a.hash);
});
test('envelope changes, hidden recipients, duplicate volatile headers and nested MIME refuse',()=>{
 const p=payload();for(const changed of [{...p,sender:'other@example.invalid'},{...p,recipient:'other@example.invalid'},{...p,recipients:2},{...p,hash:'a'.repeat(64)},change(p,'Subject:','Bcc: hidden@example.invalid\r\nSubject:'),change(p,'Date:','Date: extra\r\nDate:'),change(p,'Message-ID:','Message-ID: <extra@example.invalid>\r\nMessage-ID:'),change(p,'text/plain; charset=utf-8','multipart/mixed; boundary="nested"'),change(p,'Synthetic <'+recipient+'>','other@example.invalid, Synthetic <'+recipient+'>'),change(p,'--abc123--\r\n','--abc123--\r\nignored tail')])assert.throws(()=>inspectMime(changed),/proof MIME/);
});
test('the encoding and every extra header remain part of the approved hash',()=>{
 const p=payload(),a=inspectMime(p);assert.notEqual(inspectMime(change(p,'Subject:','X-Extra: value\r\nSubject:')).hash,a.hash);assert.notEqual(inspectMime(change(p,'quoted-printable','base64')).hash,a.hash);
});
test('Symfony unquoted boundaries preserve the same content binding across retries',()=>{
 const a=change(payload(),'boundary="abc123"','boundary=abc123'),b=change(payload({boundary:'other',id:'retry'}),'boundary="other"','boundary=other');assert.equal(inspectMime(a).hash,inspectMime(b).hash);
});

test('changing a boundary cannot split or truncate the approved HTML',()=>{
 for(const delimiter of ['--chosen \r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Other content</p>','--chosen--']){
  const html='<p>Approved</p><!--\r\n'+delimiter+'\r\n--><p>Required footer</p>';
  inspectMime(payload({html}));
  assert.throws(()=>inspectMime(payload({html,boundary:'chosen'})),/proof MIME/);
 }
});
test('volatile headers accept generated metadata only, never arbitrary unapproved text',()=>{
 const p=payload();
 for(const bad of [payload({date:'Visit https://other.invalid'}),payload({date:'Fri, 25 Sep 2026 01:00:00 +0000 (Visit https://other.invalid)'}),payload({date:'Fri,\r\n '+'x'.repeat(2000)}),change(p,'Message-ID: <','Message-ID: <https://other.invalid/'),change(p,/Message-ID: [^\r]+/,'Message-ID: <>'),change(p,/Message-ID: [^\r]+/,'Message-ID: <'+'a'.repeat(32)+'@other.invalid>')])assert.throws(()=>inspectMime(bad),/proof MIME/);
});
test('the serialized intent and exactly two MIME parts are required',()=>{
 const p=payload();assert.throws(()=>inspectMime({...p,intent:'f'.repeat(64)}),/proof MIME/);
 const part='--abc123\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nThird part\r\n';
 assert.throws(()=>inspectMime(change(p,'--abc123--\r\n',part+'--abc123--\r\n')),/proof MIME/);
});
