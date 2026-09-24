await test('Exposure bounds, overrun truth and already-queued spend holds',async()=>{
 const f=seed();await grant(f,'manager','model.call');
 const id=await op(f,'iv-overrun','manager','model.call',6),waiting=await op(f,'iv-already-queued','owner');await approve(f,id);await approve(f,waiting);const c=await claim(f,id),wc=await claim(f,waiting,'owner');
 const p=await permit(f,id,c);assert.equal(p.maxUnits,6);assert.equal(p.maxRecipients,1);const req=await consume(f,p);assert.equal(req.maxUnits,6);const r=accept(req);await finish(f,id,c,r,4,true);
 const n=await claim(f,id),p2=await permit(f,id,n);assert.equal(p2.maxUnits,2);const r2=accept(await consume(f,p2));await finish(f,id,n,r2,5,true);await finish(f,id,n,r2,5,true);
 const d=dump(f),org=d.orgs.find(x=>x._id===f.A.org),res=await get(f,id);assert.equal(res.overrun,true);assert.equal(res.usage,9);assert.equal(org.spent,9);assert.equal(org.reserved,1);assert.equal(org.active,1);assert.equal(org.anomaly,'usageOverrun');assert.equal(res.receipts.length,2);
 await reject('permit',{token:f.A.adapter,id:waiting,...wc,worker:'worker-1'},/anomaly hold/);
 await reject('claim',{token:f.A.sessions.owner,id:waiting,worker:'new'},/anomaly hold|lease/);
 const g=seed();await grant(g,'manager','model.call');const ex=await op(g,'iv-exhaust','manager','model.call',3);await approve(g,ex);const ec=await claim(g,ex);await finish(g,ex,ec,accept(await consume(g,await permit(g,ex,ec))),3,true);const nc=await claim(g,ex);await reject('permit',{token:g.A.adapter,id:ex,...nc,worker:'worker-1'},/exposure exhausted/);
});
await test('Unknown usage prevents an already queued permit and resolves idempotently',async()=>{
 const f=seed();await grant(f);const a=await op(f,'iv-missing','manager','marketing.send',2),b=await op(f,'iv-waiting');await approve(f,a);await approve(f,b);const ca=await claim(f,a),cb=await claim(f,b),r=accept(await consume(f,await permit(f,a,ca)));
 await call('reconcile',{token:f.A.adapter,id:a,...ca,providerRef:r.ref});await reject('permit',{token:f.A.adapter,id:b,...cb,worker:'worker-1'},/usage unresolved/);assert.equal(dump(f).orgs.find(x=>x._id===f.A.org).reserved,3);
 await finish(f,a,ca,r,1);await finish(f,a,ca,r,1);const org=dump(f).orgs.find(x=>x._id===f.A.org);assert.equal(org.spent,1);assert.equal(org.reserved,1);assert.equal(org.missingUsage,false);await permit(f,b,cb);
});
await test('Old consumed receipts survive provisional/final absence and conflicting receipt cannot double-charge',async()=>{
 for(const finality of ['provisional','final']){const f=seed();await grant(f);const id=await op(f,'iv-late-'+finality,'manager','marketing.send',3);await approve(f,id);const c=await claim(f,id),req=await consume(f,await permit(f,id,c));await call('unknown',{token:f.A.adapter,id,...c});await fire(f);await call('resolveUnknown',{token:f.A.adapter,id,...c,absent:true,finality});
 assert.equal(dump(f).orgs.find(x=>x._id===f.A.org).reserved,finality==='final'?0:3);const r=accept(req);await finish(f,id,c,r,2);await finish(f,id,c,r,2);const result=await get(f,id),org=dump(f).orgs.find(x=>x._id===f.A.org);assert.equal(result.state,'confirmed');assert.equal(result.late,true);assert.equal(result.receipts.length,1);assert.equal(org.spent,2);assert.equal(org.reserved,0);assert.equal(org.active,0);assert.equal(r.calls,1);if(finality==='final')assert.equal(org.anomaly,'acceptedAfterFinalAbsence');
 const collision=await call('reconcile',{token:f.A.adapter,id,...c,providerRef:'iv-contradictory-receipt-'+finality,usage:7});assert.equal(collision.accepted,false);assert.equal(dump(f).orgs.find(x=>x._id===f.A.org).spent,2);assert.equal((await get(f,id)).receipts.length,1);}
});
await test('Recipient Y callback blocks only Y, purpose/channel and same external ID tenant collisions remain isolated',async()=>{
 const f=seed();await grant(f,'manager','marketing.send',{scope:bindingScope(f.A,{bindings:[f.A.binding,f.A.bindingY]})});const x=await op(f,'iv-X'),y=await op(f,'iv-Y','manager','marketing.send',1,{binding:f.A.bindingY,payload:{...payload(),audience:['recipient-Y']}});await approve(f,x);await approve(f,y);const cx=await claim(f,x),cy=await claim(f,y);
 const cb=(t,binding,eventId,version,purpose,channel)=>call('callback',{token:t.adapter,binding,eventId,body:JSON.stringify({version,state:'suppressed',purpose,channel})});
 await cb(f.A,f.A.bindingY,'iv-Y-email',41,'marketing','email');await reject('permit',{token:f.A.adapter,id:y,...cy,worker:'worker-1'},/consent denied/);
 await cb(f.A,f.A.binding,'iv-X-sms',42,'marketing','sms');await cb(f.A,f.A.binding,'iv-X-transactional',43,'transactional','email');
 const before=dump(f).consent.filter(x=>x.org===f.A.org);await cb(f.B,f.B.bindingY,'iv-Y-email',41,'marketing','email');assert.deepEqual(dump(f).consent.filter(x=>x.org===f.A.org),before);
 const r=accept(await consume(f,await permit(f,x,cx)));await finish(f,x,cx,r);assert.equal((await get(f,x)).state,'confirmed');assert.equal(before.find(x=>x.recipient==='recipient').suppressed,false);
});
await test('Adapter cancellation signal is current, fenced and account-scoped',async()=>{
 for(const cut of ['cancel','fire','grant']){const f=seed(),g=await grant(f);const id=await op(f,'iv-signal-'+cut);await approve(f,id);const c=await claim(f,id);await permit(f,id,c);assert.equal((await read('adapterStatus',{token:f.A.adapter,id,...c})).cancel,false);
 if(cut==='cancel')await call('cancel',{token:f.A.sessions.owner,id});else if(cut==='fire')await fire(f);else await call('revokeGrant',{token:f.A.sessions.owner,id:g});
 assert.equal((await read('adapterStatus',{token:f.A.adapter,id,...c})).cancel,true);await assert.rejects(read('adapterStatus',{token:f.B.adapter,id,...c}),/adapter scope/);await assert.rejects(read('adapterStatus',{token:f.A.adapter,id,fence:c.fence+99,step:c.step}),/stale status/);}
});
await test('Real server expiry frees permit slot without the crashed adapter and preserves consumed reservation',async()=>{
 for(const used of [false,true]){const f=seed();await grant(f);const id=await op(f,'iv-crash-'+used),next=await op(f,'iv-after-crash');await approve(f,id);await approve(f,next);const c=await claim(f,id),p=await permit(f,id,c);if(used)await consume(f,p);await wait(2600);
 const result=await get(f,id);assert.equal(result.state,used?'outcomeUnknown':'queued');const d=dump(f);assert.ok(d.events.some(e=>e.resource===id&&e.actor==='system-expiry'));assert.equal(d.orgs.find(x=>x._id===f.A.org).reserved,1);const n=await claim(f,next);await permit(f,next,n);}
});
await test('Object wildcard is still object-specific and manager grant downgrade strips child lineage only',async()=>{
 const f=seed();await manage(f);const send=await grant(f),model=await grant(f,'manager','model.call'),rs={kind:'records',object:'person',records:'all',fields:['public']},rg=await grant(f,'manager','read',{scope:rs});
 for(const [parent,capability,scope] of [[send,'marketing.send',bindingScope(f.A)],[model,'model.call',modelScope],[rg,'read',rs]])await call('grant',{token:f.A.sessions.manager,target:f.A.actors.child,parent,capability,scope,mode:'propose',delegate:false,expires:Date.now()+30000});
 for(const surface of ['record','history','MCP','REST','export','report','file','provider','subscription']){const result=await read('read',{token:f.A.sessions.child,surface});assert.equal(result.length,1);assert.ok(!JSON.stringify(result).includes('secret'));}
 const queued=await op(f,'iv-delegated','child'),modelNext=await op(f,'iv-model-child','child','model.call');await approve(f,queued);await approve(f,modelNext);const c=await claim(f,queued,'child');await grant(f,'child','billing.refund');const independent=await op(f,'iv-independent-refund','child','billing.refund');await approve(f,independent);
 await call('revokeGrant',{token:f.A.sessions.owner,id:rg});await reject('permit',{token:f.A.adapter,id:queued,...c,worker:'worker-1'},/stale claim|authority/);await assert.rejects(claim(f,modelNext,'child'),/not claimable|authority/);assert.deepEqual(await read('read',{token:f.A.sessions.child,surface:'export'}),[]);assert.ok(await claim(f,independent,'child'));
});
