import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createPublicServer,formToken} from './server.mjs';
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const close=server=>new Promise(resolve=>server.close(resolve));
function call(port,host,path,{method='GET',body='',headers={},chunked=false}={}){return new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port,path,method,headers:{Host:host,...headers,...(body&&!chunked?{'Content-Length':Buffer.byteLength(body)}:{}),...(chunked?{'Transfer-Encoding':'chunked'}:{})}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));res.on('error',reject);});req.on('error',reject);req.end(body);});}
async function fixture(fn){
 const calls=[];let response={status:200,type:'text/plain',body:'native asset'};
 const native=http.createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;calls.push({path:req.url,headers:req.headers,body});res.writeHead(response.status,{'Content-Type':response.type,'Set-Cookie':'native=untrusted','Location':'https://example.invalid/redirect'});res.end(response.body);});
 const upstream='http://127.0.0.1:'+await listen(native);
 const make=t=>({host:'tenant-'+t+'.marketing-proof.invalid',key:(t==='a'?'a':'b').repeat(64),upstream,form:{id:1,name:'fixture',title:'Fixture '+t,fields:[{name:'email',type:'email',label:'Email'},{name:'firstname',type:'text',label:'First name'}]},routes:[{path:'/asset/fixture',nativePath:'/asset/native',contentType:'text/plain'}]});
 const a=make('a'),b=make('b'),sa=createPublicServer(a),sb=createPublicServer(b),pa=await listen(sa),pb=await listen(sb);
 try{await fn({a,b,pa,pb,calls,response:value=>{response=value;}});}finally{await Promise.all([close(sa),close(sb),close(native)]);}
}
const submit=(config,overrides={})=>({method:'POST',body:new URLSearchParams({email:'local@example.invalid',firstname:'Local',t:formToken(config)}).toString(),headers:{'Content-Type':'application/x-www-form-urlencoded'},...overrides});
test('only the exact host and published paths reach the native service',()=>fixture(async({a,pa,calls})=>{
 assert.equal((await call(pa,a.host,'/asset/fixture',{headers:{DNT:'0','Sec-GPC':'0'}})).body,'native asset');assert.equal(calls[0].headers.dnt,'1');assert.equal(calls[0].headers['sec-gpc'],'1');const count=calls.length;
 for(const host of ['tenant-b.marketing-proof.invalid',a.host.toUpperCase(),a.host+':80',a.host+'.'])assert.equal((await call(pa,host,'/asset/fixture')).status,421);
 for(const path of ['/api/contacts','/s/dashboard','/index.php/asset/fixture','/media/files/fixture','/form/generate.js?id=1','/mtc.js','/mtracking.gif','/asset/../fixture','/asset/%2e%2e/fixture','/asset%2ffixture','//asset/fixture','/asset/fixture/','/Asset/fixture','/asset/fixture;','/asset\\fixture','/asset/fixture?x=1','http://'+a.host+'/asset/fixture'])assert.equal((await call(pa,a.host,path)).status,404,path);
 for(const header of ['Forwarded','X-Forwarded-Host','X-Original-URL','X-Rewrite-URL'])assert.equal((await call(pa,a.host,'/asset/fixture',{headers:{[header]:'tenant-b.marketing-proof.invalid'}})).status,400);
 assert.equal(calls.length,count);
}));
test('rendered form token binds tenant, form and published field labels',()=>fixture(async({a,b,pa,pb,calls,response})=>{
 const rendered=await call(pa,a.host,'/form/1');assert.ok(rendered.body.includes('value="'+formToken(a)+'"'));assert.ok(!rendered.body.includes('mauticform['));
 assert.equal((await call(pb,b.host,'/form/1',submit(a))).status,403);
 const stale=structuredClone(a);stale.form.fields[0].label='Changed label';assert.equal((await call(pa,a.host,'/form/1',submit(stale))).status,403);assert.equal(calls.length,0);
 response({status:200,type:'application/json',body:JSON.stringify({success:1})});
 assert.equal((await call(pa,a.host,'/form/1',submit(a))).status,200);assert.equal((await call(pb,b.host,'/form/1',submit(b))).status,200);assert.equal(calls.length,2);
 for(const row of calls){assert.equal(row.path,'/form/submit?formId=1&ajax=1');assert.equal(new URLSearchParams(row.body).get('mauticform[formId]'),'1');}
}));
test('malformed, duplicate and extra form inputs never reach native capture',()=>fixture(async({a,pa,calls})=>{
 const valid=submit(a);
 for(const [suffix,status] of [['&email=other@example.invalid',400],['&mauticform%5BformId%5D=2',400],['&return=https://example.invalid',400],['&unexpected=x',400]])assert.equal((await call(pa,a.host,'/form/1',{...valid,body:valid.body+suffix})).status,status);
 for(const body of ['email=local@example.invalid','email=local@example.invalid&t=bad','email=%zz&t='+formToken(a),'email=local@example.invalid&t='+formToken(a)+'&firstname=%ff','email=local@example.invalid&t='+formToken(a)+'&firstname='+'x'.repeat(9000)])assert.ok((await call(pa,a.host,'/form/1',{...valid,body})).status>=400);
 assert.equal((await call(pa,a.host,'/form/1',{...valid,headers:{'Content-Type':'multipart/form-data; boundary=a'}})).status,415);
 assert.equal((await call(pa,a.host,'/form/1',{...valid,headers:{...valid.headers,Origin:'http://tenant-b.marketing-proof.invalid'}})).status,403);assert.equal(calls.length,0);
}));
test('client tracking headers and native cookies or redirects are not forwarded',()=>fixture(async({a,pa,calls,response})=>{
 response({status:200,type:'application/json',body:JSON.stringify({success:1})});const valid=submit(a),r=await call(pa,a.host,'/form/1',{...valid,headers:{...valid.headers,Cookie:'mtc_id=1',Referer:'http://evil.invalid',Authorization:'Basic invalid','User-Agent':'untrusted'}});
 assert.equal(r.status,200);for(const header of ['cookie','referer','authorization','user-agent'])assert.equal(calls[0].headers[header],undefined);assert.equal(r.headers['set-cookie'],undefined);assert.equal(r.headers.location,undefined);assert.equal(r.body,'Submission received');
}));
test('native validation failure, redirect and oversized responses cannot report success',()=>fixture(async({a,pa,response})=>{
 for(const candidate of [{status:200,type:'application/json',body:'{"success":0,"errorMessage":"invalid"}'},{status:200,type:'application/json',body:'{"success":0}'},{status:200,type:'application/json',body:'{}'},{status:302,type:'text/plain',body:'redirect'},{status:200,type:'text/plain',body:'{"success":1}'},{status:200,type:'application/json-evil',body:'{"success":1}'},{status:200,type:'application/json',body:JSON.stringify({success:1,padding:'x'.repeat(1048576)})}]){response(candidate);assert.equal((await call(pa,a.host,'/form/1',submit(a))).status,502);}
 response({status:302,type:'text/plain',body:'redirect'});assert.equal((await call(pa,a.host,'/asset/fixture')).status,502);
 response({status:200,type:'text/html',body:'wrong type'});assert.equal((await call(pa,a.host,'/asset/fixture')).status,502);
 response({status:200,type:'text/plain',body:'x'.repeat(1048577)});assert.equal((await call(pa,a.host,'/asset/fixture')).status,502);
}));

test('raw invalid UTF-8 and streamed oversized forms refuse before native capture',()=>fixture(async({a,pa,calls,response})=>{
 response({status:200,type:'application/json',body:'{"success":1}'});
 const valid=submit(a),raw=Buffer.concat([Buffer.from('email=local@example.invalid&firstname='),Buffer.from([255]),Buffer.from('&t='+formToken(a))]);
 assert.equal((await call(pa,a.host,'/form/1',{...valid,body:raw})).status,400);
 assert.equal((await call(pa,a.host,'/form/1',{...valid,body:new URLSearchParams({email:'local@example.invalid',firstname:'x'.repeat(20000),t:formToken(a)}).toString(),chunked:true})).status,413);
 assert.equal(calls.length,0);
}));
