import { afterEach, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { makeTest } from "./test.setup";
const record = makeFunctionReference<"mutation">("telemetry:record");
const report = makeFunctionReference<"query">("telemetry:report");
const probe = makeFunctionReference<"mutation">("telemetry:recordProbe");
const purge = makeFunctionReference<"mutation">("telemetry:purge");
const now = 1_800_000_000_000, minute = Math.floor(now / 60_000);
afterEach(() => vi.restoreAllMocks());

it("counts concurrent delivered requests and exposes exact statuses and bounded latency", async () => {
 vi.spyOn(Date,"now").mockReturnValue(now);
 const t=makeTest();
 await Promise.all(Array.from({length:50},(_,i)=>t.mutation(record,{minute,route:"rest",status:i<40?200:500,durationMs:i<40?5:300,release:"a".repeat(40)})));
 await t.mutation(probe,{minute,result:"sent"});
 await t.mutation(record,{minute,route:"probe",status:200,durationMs:1,release:"a".repeat(40)});
 const data:any=await t.query(report,{minutes:1,asOfMinute:minute});
 expect(data.observed.count).toBe(50);
 expect(data.observed.statusCounts).toEqual({"200":40,"500":10});
 expect(data.observed.serverErrorRate).toBe(0.2);
 expect(data.observed.p95UpperMs).toBe(500);
 expect(data.coverage[0].state).toBe("covered");
});

it("shows gaps and null rates instead of claiming missing transport means zero errors",async()=>{
 vi.spyOn(Date,"now").mockReturnValue(now);
 const t=makeTest();
 await t.mutation(probe,{minute:minute-4,result:"sent"});
 const data:any=await t.query(report,{minutes:5,asOfMinute:minute});
 expect(data.coverage.find((m:any)=>m.minute===minute-4).state).toBe("transport-gap");
 expect(data.observed.count).toBe(0);
 expect(data.observed.serverErrorRate).toBeNull();
 expect(data.observed.p95UpperMs).toBeNull();
 expect(data.coverage.find((m:any)=>m.minute===minute-3).state).toBe("collector-gap");
});

it("bounds release cardinality, rejects customer-shaped fields and expires old rows",async()=>{
 const clock=vi.spyOn(Date,"now").mockReturnValue(now);
 const t=makeTest();
 for(let i=0;i<10;i++) await t.mutation(record,{minute,route:"rest",status:200,durationMs:1,release:String(i).repeat(40)});
 await expect(t.mutation(record,{minute,route:"rest",status:200,durationMs:1,release:"a".repeat(40),customerEmail:"private@example.invalid"})).rejects.toThrow();
 const data:any=await t.query(report,{minutes:1,asOfMinute:minute});
 expect(data.releases).toHaveLength(5);
 expect(data.releases.find((r:any)=>r.release==="overflow").count).toBe(6);
 expect(data.observed.count).toBe(10);
 clock.mockReturnValue(now+66*60_000);
 await t.mutation(purge,{});
 expect(await t.run(ctx=>ctx.db.query("opsMetrics").collect())).toEqual([]);
});

it("schedules only bounded operational fields and survives scheduler failure",async()=>{
 const {recordResponse}=await import("./telemetryHttp");
 vi.spyOn(Date,"now").mockReturnValue(now);
 const request=new Request("https://fixture.invalid/api/v1/records/customer-private?email=private",{headers:{authorization:"Bearer private"}});
 const response=new Response("private body",{status:500});
 const deliver=vi.fn(async(..._args:unknown[])=>"scheduled");
 await recordResponse({scheduler:{runAfter:deliver}} as any,request,response,now-300);
 expect(deliver.mock.calls[0]?.[2]).toEqual({minute:minute-1,route:"rest",status:500,durationMs:300,release:"unknown"});
 await expect(recordResponse({scheduler:{runAfter:async()=>{throw new Error("Unavailable");}}} as any,request,response,now-300)).resolves.toBeUndefined();
 expect(response.status).toBe(500);
 expect(await response.text()).toBe("private body");
});

it("counts an unlisted 5xx as a server error without creating a new status label",async()=>{
 vi.spyOn(Date,"now").mockReturnValue(now);
 const t=makeTest();
 await t.mutation(record,{minute,route:"rest",status:503,durationMs:12,release:"not-a-release-private-content"});
 const data:any=await t.query(report,{minutes:1,asOfMinute:minute});
 expect(data.observed.statusCounts).toEqual({other:1});
 expect(data.observed.serverErrors).toBe(1);
 expect(data.observed.serverErrorRate).toBe(1);
 expect(data.releases).toEqual([{release:"unknown",count:1}]);
});
