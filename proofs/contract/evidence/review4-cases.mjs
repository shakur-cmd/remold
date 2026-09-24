    for (const finality of ['provisional', 'final']) await test('Settled-step ' + finality + ' absence cannot settle a later unresolved step', async () => {
        const f = seed(); await grant(f, 'manager', 'model.call');
        const id = await op(f, 'stale-absence-' + finality, 'manager', 'model.call', 5); await approve(f, id);
        const first = await claim(f, id); await finish(f, id, first, accept(await consume(f, await permit(f, id, first))), 1, true);
        const second = await claim(f, id); await consume(f, await permit(f, id, second));
        await call('unknown', { token: f.A.adapter, id, ...second });
        await reject('resolveUnknown', { token: f.A.adapter, id, ...first, absent: true, finality }, /not unknown/);
        const current = await get(f, id), before = dump(f).orgs.find(o => o._id === f.A.org);
        assert.equal(current.state, 'outcomeUnknown'); assert.equal(current.step, 2);
        assert.equal(before.reserved, 4); assert.equal(before.active, 1); assert.equal(before.spent, 1);
        await call('resolveUnknown', { token: f.A.adapter, id, ...second, absent: true, finality: 'final' });
        await call('resolveUnknown', { token: f.A.adapter, id, ...second, absent: true, finality: 'final' });
        const after = dump(f).orgs.find(o => o._id === f.A.org);
        assert.equal((await get(f, id)).state, 'refused'); assert.equal(after.reserved, 0); assert.equal(after.active, 0); assert.equal(after.spent, 1);
    });
    for (const finality of ['provisional', 'final']) await test('Old consumed fence for the same unresolved step still supports ' + finality + ' absence', async () => {
        const f = seed(); await grant(f); const id = await op(f, 'same-step-' + finality, 'manager', 'marketing.send', 5); await approve(f, id);
        const first = await claim(f, id); await consume(f, await permit(f, id, first));
        await call('unknown', { token: f.A.adapter, id, ...first });
        await call('resolveUnknown', { token: f.A.adapter, id, ...first, absent: true, finality: 'provisional' });
        const second = await claim(f, id); await consume(f, await permit(f, id, second));
        await call('unknown', { token: f.A.adapter, id, ...second });
        assert.notEqual(first.fence, second.fence); assert.equal(first.step, second.step);
        await call('resolveUnknown', { token: f.A.adapter, id, ...first, absent: true, finality });
        if (finality === 'provisional') {
            assert.equal((await get(f, id)).state, 'queued'); assert.equal(dump(f).orgs.find(o => o._id === f.A.org).reserved, 5);
            await call('cancel', { token: f.A.sessions.owner, id });
            await call('resolveUnknown', { token: f.A.adapter, id, ...first, absent: true, finality: 'final' });
        }
        await call('resolveUnknown', { token: f.A.adapter, id, ...second, absent: true, finality: 'final' });
        const after = dump(f).orgs.find(o => o._id === f.A.org);
        assert.equal(after.reserved, 0); assert.equal(after.active, 0); assert.equal(after.spent, 0);
    });
