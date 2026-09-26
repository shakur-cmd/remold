await test('Settled step1 final absence cannot release unresolved step2',async()=>{
 const f=seed();await grant(f,'manager','model.call');const id=await op(f,'iv-stale-finality','manager','model.call',5);await approve(f,id);const first=await claim(f,id);await finish(f,id,first,accept(await consume(f,await permit(f,id,first))),1,true);
 const second=await claim(f,id);await consume(f,await permit(f,id,second));await call('unknown',{token:f.A.adapter,id,...second});const before=await get(f,id);assert.equal(before.step,2);assert.equal(before.receipts.length,1);assert.equal(dump(f).orgs.find(x=>x._id===f.A.org).reserved,4);
 let denied=false;try{await call('resolveUnknown',{token:f.A.adapter,id,...first,absent:true,finality:'final'});}catch{denied=true;}
 const after=await get(f,id),org=dump(f).orgs.find(x=>x._id===f.A.org);console.log('STALE_FINALITY',JSON.stringify({denied,state:after.state,step:after.step,reserved:org.reserved,active:org.active,absence:after.absence}));
 assert.equal(org.reserved,4,'A final-absence response for settled step1 must not release unknown step2 exposure');assert.equal(org.active,1);assert.equal(after.state,'outcomeUnknown');
});
for(const finality of ['provisional','final'])await test('Third-step unknown ignores settled first and second step '+finality+' absence',async()=>{
 const f=seed();await grant(f,'manager','model.call');const id=await op(f,'iv-thirdstep-'+finality,'manager','model.call',7);await approve(f,id);const old=[];
 for(const used of [2,1]){const c=await claim(f,id);old.push(c);await finish(f,id,c,accept(await consume(f,await permit(f,id,c))),used,true);}
 const current=await claim(f,id);const req=await consume(f,await permit(f,id,current));await call('unknown',{token:f.A.adapter,id,...current});
 for(const stale of old)await reject('resolveUnknown',{token:f.A.adapter,id,...stale,absent:true,finality},/not unknown/);
 let data=dump(f),org=data.orgs.find(x=>x._id===f.A.org);assert.equal((await get(f,id)).step,3);assert.equal((await get(f,id)).state,'outcomeUnknown');assert.equal(org.spent,3);assert.equal(org.reserved,4);assert.equal(org.active,1);
 const r=accept(req);await finish(f,id,current,r,2);assert.equal((await get(f,id)).state,'confirmed');assert.equal((await get(f,id)).receipts.length,3);for(const stale of [...old,current])await reject('resolveUnknown',{token:f.A.adapter,id,...stale,absent:true,finality:'final'},/not unknown/);org=dump(f).orgs.find(x=>x._id===f.A.org);assert.equal(org.spent,5);assert.equal(org.reserved,0);assert.equal(org.active,0);assert.equal(org.anomaly,undefined);
});
for(const finality of ['provisional','final'])await test('Oldest of three retry fences for one current unresolved step supports '+finality+' finality',async()=>{
 const f=seed();await grant(f);const id=await op(f,'iv-same-step-three-'+finality,'manager','marketing.send',6);await approve(f,id);const cs=[];
 for(let i=0;i<3;i++){const c=await claim(f,id,'manager','iv-retry-'+i);cs.push(c);await consume(f,await permit(f,id,c,'iv-retry-'+i));await call('unknown',{token:f.A.adapter,id,...c});if(i<2)await call('resolveUnknown',{token:f.A.adapter,id,...c,absent:true,finality:'provisional'});}
 assert.equal(new Set(cs.map(c=>c.fence)).size,3);assert.equal(new Set(cs.map(c=>c.step)).size,1);
 await reject('resolveUnknown',{token:f.B.sessions.owner,id,...cs[0],absent:true,finality},/tenant/);
 await call('resolveUnknown',{token:finality==='final'?f.A.sessions.owner:f.A.adapter,id,...cs[0],absent:true,finality});
 if(finality==='provisional'){assert.equal((await get(f,id)).state,'queued');assert.equal(dump(f).orgs.find(x=>x._id===f.A.org).reserved,6);await call('cancel',{token:f.A.sessions.owner,id});await call('resolveUnknown',{token:f.A.sessions.owner,id,...cs[1],absent:true,finality:'final'});}
 await Promise.all(cs.map(c=>call('resolveUnknown',{token:f.A.adapter,id,...c,absent:true,finality:'final'})));const org=dump(f).orgs.find(x=>x._id===f.A.org);assert.equal(org.reserved,0);assert.equal(org.active,0);assert.equal(org.spent,0);
});
