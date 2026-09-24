import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const here=fileURLToPath(new URL('.',import.meta.url));
const run='00000000-0000-4000-8000-000000000000';
const valid={name:'reply-P',from:'reply@repliedfor.com',to:'shakur@envoylogic.com',subject:`Re: Remold P5 test ${run} P`,messageId:`<remold-p5-${run}-reply-P@repliedfor.com>`,inReplyTo:`<remold-p5-${run}-P1@repliedfor.com>`,text:'Yes, stop this controlled test sequence.'};
function validate(message){return execFileSync('python3',['-c','import json,sys; from purelymail_payload import validate_send; validate_send(json.load(sys.stdin))'],{cwd:here,input:JSON.stringify(message),stdio:['pipe','pipe','pipe']});}
test('the exact planned plain-text reply is transport-valid before any provider connection',()=>{assert.doesNotThrow(()=>validate(valid));});
test('unplanned reply subject, extra header, foreign recipient and wrong reference fail offline',()=>{
  for(const patch of [{subject:'Re: Other mail'},{subject:valid.subject+'\r\nBcc: third@example.com'},{to:'third@example.com'},{inReplyTo:`<remold-p5-${run}-Q1@repliedfor.com>`}])assert.throws(()=>validate({...valid,...patch}));
});
test('resume accepts only the verified provider reference for P reply and leaves Q references unchanged',()=>{
 const reference='<actual123@mail.gmail.com>';
 const script='import json,sys; from purelymail_payload import validate_send; x=json.load(sys.stdin); validate_send(x["message"],x["reference"])';
 const check=message=>execFileSync('python3',['-c',script],{cwd:here,input:JSON.stringify({message,reference}),stdio:['pipe','pipe','pipe']});
 assert.doesNotThrow(()=>check({...valid,inReplyTo:reference}));
 assert.throws(()=>check({...valid,inReplyTo:'<other@mail.gmail.com>'}));
 assert.throws(()=>check({...valid,inReplyTo:reference+'\r\nBcc: bad@example.invalid'}));
});
