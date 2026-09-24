    for (const path of ['sweep', 'expiry', 'failure']) await test('Unresolved consumed attempt survives ' + path + ' and holds global exposure', async () => {
        const f = seed(); await grant(f);
        const id = await op(f, path, 'manager', 'marketing.send', 8); await approve(f, id);
        const c = await claim(f, id), request = await consume(f, await permit(f, id, c));
        await call('unknown', {token:f.A.adapter,id,...c});
        await call('resolveUnknown', {token:f.A.adapter,id,...c,absent:true,finality:'provisional'});
        if (path === 'sweep') await fire(f);
        else {
            const d = await claim(f,id); await permit(f,id,d);
            if (path === 'expiry') { await call('control',{token:f.A.sessions.owner,binding:f.A.binding,healthy:false}); await wait(1400); }
            else await call('fail',{token:f.A.adapter,id,...d,retryable:false});
        }
        assert.equal((await get(f,id)).state,'outcomeUnknown');
        let a = dump(f).orgs.find(o=>o._id===f.A.org); assert.equal(a.reserved,8); assert.equal(a.active,1);
        const b = {...f,A:f.B}; const other = await op(b,'global-blocked','owner','marketing.send',8,{payload:payload('B')}); await approve(b,other);
        await assert.rejects(claim(b,other,'owner'),/global budget/);
        const receipt=accept(request); await finish(f,id,c,receipt,7); await finish(f,id,c,receipt,7);
        a=dump(f).orgs.find(o=>o._id===f.A.org);
        assert.equal((await get(f,id)).state,'confirmed'); assert.equal((await get(f,id)).late,true);
        assert.equal(a.reserved,0); assert.equal(a.active,0); assert.equal(a.spent,7); assert.equal(a.anomaly,undefined);
        await claim(b,other,'owner');
    });
    await test('Cancellation cannot release confirmed work with missing usage', async()=>{
        const f=seed(); await grant(f); const id=await op(f,'missing-cancel','manager','marketing.send',8); await approve(f,id);
        const c=await claim(f,id), receipt=accept(await consume(f,await permit(f,id,c)));
        await call('reconcile',{token:f.A.adapter,id,...c,providerRef:receipt.ref});
        await call('cancel',{token:f.A.sessions.owner,id});
        let a=dump(f).orgs.find(o=>o._id===f.A.org); assert.equal(a.reserved,8); assert.equal(a.active,1);
        const b={...f,A:f.B}, other=await op(b,'global-blocked','owner','marketing.send',8,{payload:payload('B')}); await approve(b,other);
        await assert.rejects(claim(b,other,'owner'),/global budget/);
        await finish(f,id,c,receipt,7); await finish(f,id,c,receipt,7);
        a=dump(f).orgs.find(o=>o._id===f.A.org); assert.equal(a.reserved,0); assert.equal(a.active,0); assert.equal(a.spent,7);
        assert.equal(a.missingUsage,false); await claim(b,other,'owner');
    });
    for(const cancelled of [false,true]) await test('Unconsumed unknown is ignored and scheduler recovers '+cancelled,async()=>{
        const f=seed(); await grant(f); const id=await op(f,'never-sent'); await approve(f,id);
        const c=await claim(f,id); await permit(f,id,c); await call('unknown',{token:f.A.adapter,id,...c});
        if(cancelled) await call('cancel',{token:f.A.sessions.owner,id});
        await wait(1400); const current=await get(f,id); assert.equal(current.state,cancelled?'cancelled':'queued');
        assert.equal(current.consumedPermits.length,0); assert.equal(current.receipts.length,0);
        if(cancelled) assert.equal(dump(f).orgs.find(o=>o._id===f.A.org).active,0);
        else assert.ok(await claim(f,id));
    });
    for(const missing of [false,true]) await test('Single-step accepted overrun remains confirmed '+missing,async()=>{
        const f=seed(); await grant(f); const id=await op(f,'single-overrun'); await approve(f,id);
        const c=await claim(f,id),receipt=accept(await consume(f,await permit(f,id,c)));
        if(missing) await call('reconcile',{token:f.A.adapter,id,...c,providerRef:receipt.ref});
        await finish(f,id,c,receipt,2); await finish(f,id,c,receipt,2);
        assert.equal((await get(f,id)).state,'confirmed'); const a=dump(f).orgs.find(o=>o._id===f.A.org);
        assert.equal(a.spent,2); assert.equal(a.reserved,0); assert.equal(a.active,0); assert.equal(a.anomaly,'usageOverrun');
        const fresh=await op(f,'hold','owner'); await approve(f,fresh); await assert.rejects(claim(f,fresh,'owner'),/anomaly hold/);
    });
    await test('Exhausted successful continuation settles and releases its slot',async()=>{
        const f=seed(); await grant(f,'manager','model.call'); const id=await op(f,'exhausted','manager','model.call',2); await approve(f,id);
        const c=await claim(f,id), receipt=accept(await consume(f,await permit(f,id,c)));
        const result=await finish(f,id,c,receipt,2,true); assert.equal(result.continuationRefused,true);
        assert.equal((await get(f,id)).state,'confirmed'); assert.equal(dump(f).orgs.find(o=>o._id===f.A.org).active,0);
        await assert.rejects(claim(f,id),/released|not claimable/);
    });
    await test('Suppression without an existing purpose/channel row is durable',async()=>{
        const f=seed(); await inbound(f.A,signed(f.A,'new-purpose',JSON.stringify({version:1,state:'suppressed',channel:'sms',purpose:'marketing'})));
        const rows=dump(f).consent.filter(c=>c.org===f.A.org&&c.recipient==='recipient');
        assert.equal(rows.find(c=>c.channel==='sms'&&c.purpose==='marketing')?.suppressed,true);
        assert.equal(rows.find(c=>c.channel==='email'&&c.purpose==='marketing').suppressed,false);
    });
