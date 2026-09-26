import {createHash} from 'node:crypto';
const fail=()=>{throw Error('Unsupported or mismatched proof MIME');};
const hash=value=>createHash('sha256').update(value).digest('hex');
function fields(block){
 const result=[];
 for(const line of block.split('\r\n')){
  if(/^[ \t]/.test(line)){if(!result.length)fail();result.at(-1).raw+='\r\n'+line;continue;}
  const match=/^([A-Za-z0-9-]+):[ \t]*(.*)$/.exec(line);if(!match)fail();result.push({name:match[1].toLowerCase(),raw:line});
 }
 return result;
}
const values=(headers,name)=>headers.filter(h=>h.name===name).map(h=>h.raw.slice(h.raw.indexOf(':')+1).replace(/\r\n[ \t]+/g,' ').trim());
function one(headers,name){const list=values(headers,name);if(list.length!==1)fail();return list[0];}
function address(value){
 // This fixture permits a plain address or an ASCII display name, not a general address-list grammar.
 const match=/^(?:(?:[A-Za-z0-9 ._-]+ )?<([^<> ,]+)>|([^<> ,]+))$/.exec(value),a=match?.[1]??match?.[2];
 if(!a||!/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/.test(a))fail();return a;
}
export function inspectMime(a){
 if(!a||Object.keys(a).sort().join(',')!=='intent,raw,recipient,recipients,sender'||a.recipients!==1||!/^[a-f0-9]{64}$/.test(a.intent)||typeof a.raw!=='string'||a.raw.length>60000)fail();
 const bytes=Buffer.from(a.raw,'base64');if(!bytes.length||bytes.toString('base64')!==a.raw||bytes.length>45000||bytes.some(b=>b>127||b===0))fail();
 const text=bytes.toString('ascii');if(/(?<!\r)\n|\r(?!\n)/.test(text))fail();
 const split=text.indexOf('\r\n\r\n');if(split<0)fail();const headers=fields(text.slice(0,split)),body=text.slice(split+4);
 if(values(headers,'cc').length||values(headers,'bcc').length)fail();
 if(address(one(headers,'to'))!==a.recipient||address(one(headers,'from'))!==a.sender||one(headers,'x-remold-intent')!==a.intent)fail();
 for(const name of ['sender','return-path']){const list=values(headers,name);if(list.length>1||list.some(v=>address(v)!==a.sender))fail();}
 one(headers,'subject');one(headers,'date');one(headers,'message-id');if(one(headers,'mime-version')!=='1.0')fail();
 const type=one(headers,'content-type'),match=/^multipart\/alternative;\s*boundary=("?)([A-Za-z0-9_-]{1,70})\1$/i.exec(type);if(!match)fail();const [,quote,boundary]=match;
 const begin='--'+boundary+'\r\n',end='\r\n--'+boundary+'--\r\n';if(!body.startsWith(begin)||!body.endsWith(end))fail();
 const parts=body.slice(begin.length,-end.length).split('\r\n--'+boundary+'\r\n');if(parts.length!==2)fail();
 for(const [index,part] of parts.entries()){
  const at=part.indexOf('\r\n\r\n');if(at<0)fail();const partHeaders=fields(part.slice(0,at));
  if(partHeaders.length!==2||!new RegExp('^text/'+(index===0?'plain':'html')+'; charset=utf-8$','i').test(one(partHeaders,'content-type'))||!['quoted-printable','base64'].includes(one(partHeaders,'content-transfer-encoding').toLowerCase()))fail();
 }
 const stableHeaders=headers.filter(h=>!['date','message-id'].includes(h.name)).map(h=>h.name==='content-type'?h.raw.replace('boundary='+quote+boundary+quote,'boundary='+quote+'REMOLD_BOUNDARY'+quote):h.raw).join('\r\n');
 // Structured parts avoid treating a matching boundary token inside ordinary body content as a delimiter.
 const normalized=JSON.stringify({sender:a.sender,recipient:a.recipient,headers:stableHeaders,parts});
 return {intent:a.intent,sender:a.sender,recipient:a.recipient,hash:hash(normalized),rawSha256:hash(bytes),bytes};
}
