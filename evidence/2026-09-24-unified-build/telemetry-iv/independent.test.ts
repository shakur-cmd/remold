import { it, expect, vi, afterEach } from 'vitest';
import { makeFunctionReference } from 'convex/server';
import { makeTest } from '../../../convex/test.setup';
const record=makeFunctionReference<'mutation'>('telemetry:record'),report=makeFunctionReference<'query'>('telemetry:report');
afterEach(()=>vi.restoreAllMocks());
it('full finite dimensions stay bounded while overflow durations and error classes remain truthful',async()=>{
 const now=1_900_000_000_000,minute=Math.floor(now/60000);vi.spyOn(Date,'now').mockReturnValue(now);const t=makeTest();
 for(const route of ['rest','probe'])for(let i=0;i<5;i++)for(const status of [200,201,400,401,403,404,409,429,500,503])await t.mutation(record,{minute,route,status,durationMs:status===503?10001:10,release:String(i).repeat(40)});
 const rows=await t.run(ctx=>ctx.db.query('opsMetrics').collect());expect(rows).toHaveLength(100);
 const data:any=await t.query(report,{minutes:1,asOfMinute:minute});expect(data.observed.count).toBe(50);expect(data.observed.serverErrors).toBe(10);expect(data.observed.clientErrors).toBe(30);expect(data.observed.serverErrorRate).toBe(.2);expect(data.observed.p50UpperMs).toBe(10);expect(data.observed.p95UpperMs).toBeNull();expect(data.observed.maxMs).toBe(10001);expect(data.releases).toHaveLength(5);expect(data.releases.reduce((n:number,r:any)=>n+r.count,0)).toBe(50);expect(data.coverage[0].state).toBe('provisional');expect(data.deliveryComplete).toBe(false);
 await t.mutation(record,{minute,route:'rest',status:503,durationMs:10001,release:'private-invalid-release'});expect(await t.run(ctx=>ctx.db.query('opsMetrics').collect())).toHaveLength(100);
 const after:any=await t.query(report,{minutes:1,asOfMinute:minute});expect(after.observed.count).toBe(51);expect(after.observed.serverErrors).toBe(11);expect(JSON.stringify(await t.run(ctx=>ctx.db.query('opsMetrics').collect()))).not.toContain('private-invalid');
});
it('recent historical windows exclude outside rows and reject requests beyond retained coverage',async()=>{
 const now=1_900_000_000_000,minute=Math.floor(now/60000);vi.spyOn(Date,'now').mockReturnValue(now);const t=makeTest();
 for(const delta of [0,-1,-60,-65])await t.mutation(record,{minute:minute+delta,route:'rest',status:200,durationMs:25,release:'unknown'});
 const recent:any=await t.query(report,{minutes:1,asOfMinute:minute});expect(recent.observed.count).toBe(1);expect(recent.window.partialCurrentMinute).toBe(true);
 const old:any=await t.query(report,{minutes:6,asOfMinute:minute-60});expect(old.observed.count).toBe(2);expect(old.window.partialCurrentMinute).toBe(false);expect(old.coverage.every((m:any)=>m.state==='collector-gap')).toBe(true);
 await expect(t.query(report,{minutes:7,asOfMinute:minute-60})).rejects.toThrow(/retained/);await expect(t.mutation(record,{minute:minute-66,route:'rest',status:200,durationMs:1,release:'unknown'})).rejects.toThrow(/Invalid operational span/);
});
