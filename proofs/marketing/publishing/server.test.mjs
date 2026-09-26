import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createPublicServer,formToken} from './server.mjs';
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const close=server=>new Promise(resolve=>server.close(resolve));
function call(port,host,path,{method='GET',body='',headers={},chunked=false}={}){return new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port,path,method,headers:{Host:host,...headers,...(body&&!chunked?{'Content-Length':Buffer.byteLength(body)}:{}),...(chunked?{'Transfer-Encoding':'chunked'}:{})}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));res.on('error',reject);});req.on('error',reject);req.end(body);});}
async function fixture(fn){
 const calls=[],stored=[];let response={status:200,type:'text/plain',body:'native asset'},capture=args=>({status:'success',value:{id:'k'+stored.length,duplicate:false}});
 const native=http.createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;calls.push({method:req.method,path:req.url,headers:req.headers,body});res.writeHead(response.status,{'Content-Type':response.type,'Set-Cookie':'native=untrusted','Location':'https://example.invalid/redirect'});res.end(response.body);});
 const store=http.createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;const request=JSON.parse(body);stored.push({path:req.url,headers:req.headers,request});const out=capture(request.args);if(out==='drop'){req.socket.destroy();return;}res.writeHead(200,{'Content-Type':'application/json'});res.end(typeof out==='string'?out:JSON.stringify(out));});
 const upstream='http://127.0.0.1:'+await listen(native),storeUrl='http://127.0.0.1:'+await listen(store);
 const make=t=>({host:'tenant-'+t+'.marketing-proof.invalid',key:(t==='a'?'a':'b').repeat(64),upstream,form:{id:'intake',title:'Fixture '+t,fields:[{name:'email',type:'email',label:'Email'},{name:'firstname',type:'text',label:'First name'}]},capture:{url:storeUrl,key:(t==='a'?'c':'d').repeat(64)},routes:[{path:'/asset/fixture',nativePath:'/asset/native',contentType:'text/plain'}]});
 const a=make('a'),b=make('b'),sa=createPublicServer(a),sb=createPublicServer(b),pa=await listen(sa),pb=await listen(sb);
 try{await fn({a,b,pa,pb,calls,stored,response:value=>{response=value;},capture:value=>{capture=value;}});}finally{await Promise.all([close(sa),close(sb),close(native),close(store)]);}
}
const nonce='0123456789abcdef0123456789abcdef';
const submit=(config,overrides={})=>({method:'POST',body:new URLSearchParams({email:'local@example.invalid',firstname:'Local',t:formToken(config),n:nonce}).toString(),headers:{'Content-Type':'application/x-www-form-urlencoded'},...overrides});
test('only the exact host and published paths reach the native service',()=>fixture(async({a,pa,calls})=>{
 assert.equal((await call(pa,a.host,'/asset/fixture',{headers:{DNT:'0','Sec-GPC':'0'}})).body,'native asset');assert.equal(calls[0].headers.dnt,'1');assert.equal(calls[0].headers['sec-gpc'],'1');const count=calls.length;
 for(const host of ['tenant-b.marketing-proof.invalid',a.host.toUpperCase(),a.host+':80',a.host+'.'])assert.equal((await call(pa,host,'/asset/fixture')).status,421);
 for(const path of ['/api/contacts','/s/dashboard','/index.php/asset/fixture','/media/files/fixture','/form/generate.js?id=1','/form/submit?formId=1','/mtc.js','/mtracking.gif','/asset/../fixture','/asset/%2e%2e/fixture','/asset%2ffixture','//asset/fixture','/asset/fixture/','/Asset/fixture','/asset/fixture;','/asset\\fixture','/asset/fixture?x=1','http://'+a.host+'/asset/fixture'])assert.equal((await call(pa,a.host,path)).status,404,path);
 for(const header of ['Forwarded','X-Forwarded-Host','X-Original-URL','X-Rewrite-URL'])assert.equal((await call(pa,a.host,'/asset/fixture',{headers:{[header]:'tenant-b.marketing-proof.invalid'}})).status,400);
 assert.equal(calls.length,count);
}));
test('a valid submission is stored once through the tenant capture key and never posted to Mautic',()=>fixture(async({a,b,pa,pb,calls,stored})=>{
 const rendered=await call(pa,a.host,'/form/intake');assert.ok(rendered.body.includes('value="'+formToken(a)+'"'));assert.match(rendered.body,/name="n" value="[a-f0-9]{32}"/);assert.ok(!rendered.body.includes('mauticform['));
 assert.notEqual(rendered.body.match(/name="n" value="([a-f0-9]{32})"/)[1],(await call(pa,a.host,'/form/intake')).body.match(/name="n" value="([a-f0-9]{32})"/)[1]);
 assert.equal((await call(pa,a.host,'/form/intake',submit(a))).status,200);assert.equal((await call(pb,b.host,'/form/intake',submit(b))).status,200);
 assert.deepEqual(stored.map(s=>[s.path,s.request.path,s.request.args.key,s.request.args.idempotencyKey,s.request.args.email]),[['/api/mutation','capture:capture',a.capture.key,nonce,'local@example.invalid'],['/api/mutation','capture:capture',b.capture.key,nonce,'local@example.invalid']]);
 assert.equal(calls.length,0,'No request of any kind reaches Mautic for a submission');
}));
test('the rendered token binds tenant and field labels',()=>fixture(async({a,b,pa,pb,stored})=>{
 assert.equal((await call(pb,b.host,'/form/intake',submit(a))).status,403);
 const stale=structuredClone(a);stale.form.fields[0].label='Changed label';assert.equal((await call(pa,a.host,'/form/intake',submit(stale))).status,403);assert.equal(stored.length,0);
}));
test('malformed, duplicate, extra or nonce-less form inputs never reach capture',()=>fixture(async({a,pa,stored})=>{
 const valid=submit(a);
 for(const suffix of ['&email=other@example.invalid','&n='+nonce,'&mauticform%5BformId%5D=2','&return=https://example.invalid','&unexpected=x'])assert.equal((await call(pa,a.host,'/form/intake',{...valid,body:valid.body+suffix})).status,400);
 for(const body of ['email=local@example.invalid&n='+nonce,'email=local@example.invalid&t=bad&n='+nonce,'email=local@example.invalid&t='+formToken(a),'email=local@example.invalid&t='+formToken(a)+'&n=short','email=%zz&t='+formToken(a)+'&n='+nonce,'email=local@example.invalid&t='+formToken(a)+'&n='+nonce+'&firstname=%ff','email=local@example.invalid&t='+formToken(a)+'&n='+nonce+'&firstname='+'x'.repeat(9000)])assert.ok((await call(pa,a.host,'/form/intake',{...valid,body})).status>=400,body.slice(0,60));
 assert.equal((await call(pa,a.host,'/form/intake',{...valid,headers:{'Content-Type':'multipart/form-data; boundary=a'}})).status,415);
 assert.equal((await call(pa,a.host,'/form/intake',{...valid,headers:{...valid.headers,Origin:'http://tenant-b.marketing-proof.invalid'}})).status,403);assert.equal(stored.length,0);
}));
test('client cookies and headers never reach capture',()=>fixture(async({a,pa,stored})=>{
 const valid=submit(a),r=await call(pa,a.host,'/form/intake',{...valid,headers:{...valid.headers,Cookie:'mtc_id=1',Referer:'http://evil.invalid',Authorization:'Basic invalid','User-Agent':'untrusted'}});
 assert.equal(r.status,200);for(const header of ['cookie','referer','authorization','user-agent'])assert.equal(stored[0].headers[header],undefined);assert.deepEqual(Object.keys(stored[0].request.args).sort(),['email','firstname','idempotencyKey','key']);assert.equal(r.headers['set-cookie'],undefined);
}));
test('success is reported only for a confirmed capture; a reused nonce with other values is a conflict',()=>fixture(async({a,pa,capture})=>{
 for(const out of ['drop','not json',{status:'error',errorMessage:'boom'},{status:'success',value:null},{status:'error',errorData:{code:'credential'}}]){capture(()=>out);assert.equal((await call(pa,a.host,'/form/intake',submit(a))).status,502,JSON.stringify(out));}
 capture(()=>({status:'error',errorData:{code:'conflict'}}));assert.equal((await call(pa,a.host,'/form/intake',submit(a))).status,409);
 capture(()=>({status:'success',value:{id:'x',duplicate:true}}));assert.equal((await call(pa,a.host,'/form/intake',submit(a))).status,200);
}));
test('native redirects and oversized page responses are not published',()=>fixture(async({a,pa,response})=>{
 response({status:302,type:'text/plain',body:'redirect'});assert.equal((await call(pa,a.host,'/asset/fixture')).status,502);
 response({status:200,type:'text/html',body:'wrong type'});assert.equal((await call(pa,a.host,'/asset/fixture')).status,502);
 response({status:200,type:'text/plain',body:'x'.repeat(1048577)});assert.equal((await call(pa,a.host,'/asset/fixture')).status,502);
}));
test('raw invalid UTF-8 and streamed oversized forms refuse before capture',()=>fixture(async({a,pa,stored})=>{
 const valid=submit(a),raw=Buffer.concat([Buffer.from('email=local@example.invalid&firstname='),Buffer.from([255]),Buffer.from('&t='+formToken(a)+'&n='+nonce)]);
 assert.equal((await call(pa,a.host,'/form/intake',{...valid,body:raw})).status,400);
 assert.equal((await call(pa,a.host,'/form/intake',{...valid,body:new URLSearchParams({email:'local@example.invalid',firstname:'x'.repeat(20000),t:formToken(a),n:nonce}).toString(),chunked:true})).status,413);
 assert.equal(stored.length,0);
}));
test('only plain addresses up to 64 characters and first names up to 64 are captured; the rest are refused before capture',()=>fixture(async({a,pa,stored})=>{
 const post=email=>call(pa,a.host,'/form/intake',submit(a,{body:new URLSearchParams({email,firstname:'Local',t:formToken(a),n:nonce}).toString()}));
 for(const email of ['plain@example.invalid','First.Last+tag@Sub-1.example.invalid','under_score@example.invalid','x'.repeat(48)+'@example.invalid'])assert.equal((await post(email)).status,200,email);
 const accepted=stored.length;
 for(const email of ['iv%pct@example.invalid','%@%.%','a*b@example.invalid',"o'neil@example.invalid",'a&b@example.invalid','a b@example.invalid','.a@example.invalid','a..b@example.invalid','a.@example.invalid','a@-x.invalid','a@b','a@@example.invalid','"q"@example.invalid','x'.repeat(49)+'@example.invalid','x'.repeat(65)+'@example.invalid','a@'+'d'.repeat(250)+'.invalid'])assert.equal((await post(email)).status,400,email);
 assert.equal(stored.length,accepted);
 const named=firstname=>call(pa,a.host,'/form/intake',submit(a,{body:new URLSearchParams({email:'plain@example.invalid',firstname,t:formToken(a),n:nonce}).toString()}));
 assert.equal((await named('N'.repeat(64))).status,200);assert.equal((await named('N'.repeat(65))).status,400);assert.equal(stored.length,accepted+1);
}));
test('an edge without a well-formed capture key or store refuses to start',()=>{
 const config={host:'tenant-a.marketing-proof.invalid',key:'a'.repeat(64),upstream:'http://127.0.0.1:9',form:{id:'intake',title:'Fixture',fields:[{name:'email',type:'email',label:'Email'},{name:'firstname',type:'text',label:'First name'}]},routes:[]};
 for(const capture of [undefined,{url:'http://127.0.0.1:9'},{url:'http://127.0.0.1:9',key:'short'},{url:'https://user:pw@x/',key:'c'.repeat(64)}])assert.throws(()=>createPublicServer({...config,capture}));
 assert.doesNotThrow(()=>createPublicServer({...config,capture:{url:'http://127.0.0.1:9',key:'c'.repeat(64)}}));
});
