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
