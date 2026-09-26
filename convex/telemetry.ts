declare const process: { env: Record<string, string | undefined> };
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";

export const BUCKET_SET = "rest-handler-ms-v1";
export const BOUNDS_MS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const statuses = new Set([200, 201, 400, 401, 403, 404, 409, 429, 500]);
const currentMinute = () => Math.floor(Date.now() / 60_000);
const releaseTag = (release: string) => /^[0-9a-f]{40}$/.test(release) ? release : "unknown";

export const record = internalMutation({
 args: { minute: v.number(), route: v.union(v.literal("rest"),v.literal("probe")), status: v.number(), durationMs: v.number(), release: v.string() },
 handler: async (ctx,args) => {
  const now=currentMinute();
  if(!Number.isInteger(args.minute)||args.minute<now-65||args.minute>now||!Number.isFinite(args.durationMs)||args.durationMs<0||args.durationMs>3_600_000||!Number.isInteger(args.status)||args.status<100||args.status>599) throw new Error("Invalid operational span");
  // Opportunistic expiry also bounds storage if the purge cron stops running.
  const expired=await ctx.db.query("opsMetrics").withIndex("by_minute",q=>q.lt("minute",now-65)).first();
  if(expired)await ctx.db.delete(expired._id);
  let release=releaseTag(args.release);
  const status=statuses.has(args.status)?String(args.status):"other";
  const rows=await ctx.db.query("opsMetrics").withIndex("by_minute",q=>q.eq("minute",args.minute)).take(101);
  const releases=new Set(rows.map(r=>r.release).filter(r=>r!=="overflow"));
  if(!releases.has(release)&&releases.size>=4)release="overflow";
  const row=rows.find(r=>r.route===args.route&&r.status===status&&r.release===release);
  const buckets=row?[...row.buckets]:Array(BOUNDS_MS.length+1).fill(0) as number[];
  const index=BOUNDS_MS.findIndex(bound=>args.durationMs<=bound);
  buckets[index===-1?BOUNDS_MS.length:index]++;
  const data={minute:args.minute,route:args.route,status,release,count:(row?.count??0)+1,serverErrors:(row?.serverErrors??0)+(args.status>=500?1:0),clientErrors:(row?.clientErrors??0)+(args.status>=400&&args.status<500?1:0),sumMs:(row?.sumMs??0)+args.durationMs,maxMs:Math.max(row?.maxMs??0,args.durationMs),buckets};
  if(row)await ctx.db.replace(row._id,data);else await ctx.db.insert("opsMetrics",data);
 },
});

export const recordProbe = internalMutation({
 args: {minute:v.number(),result:v.union(v.literal("sent"),v.literal("failed"),v.literal("unconfigured"))},
 handler:async(ctx,args)=>{
  const now=currentMinute();
  if(!Number.isInteger(args.minute)||args.minute<now-65||args.minute>now)throw new Error("Invalid probe minute");
  const expired=await ctx.db.query("opsProbes").withIndex("by_minute",q=>q.lt("minute",now-65)).first();
  if(expired)await ctx.db.delete(expired._id);
  const row=await ctx.db.query("opsProbes").withIndex("by_minute",q=>q.eq("minute",args.minute)).unique();
  if(row)await ctx.db.patch(row._id,args);else await ctx.db.insert("opsProbes",args);
 },
});

export const probe = internalAction({args:{},handler:async(ctx)=>{
 const minute=currentMinute(),secret=process.env.REMOLD_METRICS_PROBE_SECRET,site=process.env.CONVEX_SITE_URL;
 let result:"sent"|"failed"|"unconfigured"="unconfigured";
 if(secret&&secret.length>=32&&site){
  try{const response=await fetch(`${site}/api/v1/_probe`,{headers:{authorization:`Bearer ${secret}`},signal:AbortSignal.timeout(10_000)});result=response.status===200?"sent":"failed";}
  catch{result="failed";}
 }
 await ctx.runMutation(internal.telemetry.recordProbe,{minute,result});
}});

export const purge=internalMutation({args:{},handler:async(ctx)=>{
 const cutoff=currentMinute()-65;
 for(const table of ["opsMetrics","opsProbes"] as const){
  const expired=await ctx.db.query(table).withIndex("by_minute",q=>q.lt("minute",cutoff)).take(500);
  for(const row of expired)await ctx.db.delete(row._id);
  if(expired.length===500)await ctx.scheduler.runAfter(0,internal.telemetry.purge,{});
 }
}});

export const report=internalQuery({args:{minutes:v.number(),asOfMinute:v.number()},handler:async(ctx,{minutes,asOfMinute})=>{
 if(!Number.isInteger(minutes)||minutes<1||minutes>60||!Number.isInteger(asOfMinute)||asOfMinute>currentMinute()||asOfMinute<currentMinute()-60)throw new Error("Use a recent 1–60 minute window");
 const from=asOfMinute-minutes+1;
 if(from<currentMinute()-65)throw new Error("Window exceeds retained coverage");
 const rows=await ctx.db.query("opsMetrics").withIndex("by_minute",q=>q.gte("minute",from).lte("minute",asOfMinute)).take(6001);
 const probes=await ctx.db.query("opsProbes").withIndex("by_minute",q=>q.gte("minute",from).lte("minute",asOfMinute)).take(61);
 const rest=rows.filter(row=>row.route==="rest");
 const serverErrors=rest.reduce((n,r)=>n+r.serverErrors,0);
 const count=rest.reduce((n,r)=>n+r.count,0),sumMs=rest.reduce((n,r)=>n+r.sumMs,0);
 const buckets=BOUNDS_MS.map(()=>0).concat(0),statusCounts:Record<string,number>={};
 for(const row of rest){statusCounts[row.status]=(statusCounts[row.status]??0)+row.count;row.buckets.forEach((n,i)=>buckets[i]+=n);}
 const percentile=(fraction:number)=>{if(!count)return null;let n=0;const index=buckets.findIndex(b=>{n+=b;return n>=Math.ceil(count*fraction)});return BOUNDS_MS[index]??null;};
 const coverage=Array.from({length:minutes},(_,i)=>{
  const minute=from+i,probe=probes.find(p=>p.minute===minute);
  const covered=probe?.result==="sent"&&rows.some(r=>r.minute===minute&&r.route==="probe"&&r.status==="200"&&r.count>0);
  return {minute,state:covered?"covered":minute>currentMinute()-3?"provisional":probe?.result==="sent"?"transport-gap":"collector-gap",probeResult:probe?.result??null};
 });
 const oldest=await ctx.db.query("opsMetrics").withIndex("by_minute").first();
 return {definition:BUCKET_SET,source:"REST HTTP action start through response construction; excludes scheduler overhead and platform queueing",window:{fromMinute:from,throughMinute:asOfMinute,partialCurrentMinute:asOfMinute===currentMinute()},sample:"all successfully delivered server spans; no statistical sampling",deliveryComplete:false,coverage,observed:{count,statusCounts,serverErrors,serverErrorRate:count?serverErrors/count:null,clientErrors:rest.reduce((n,r)=>n+r.clientErrors,0),rateLimited:statusCounts["429"]??0,meanMs:count?sumMs/count:null,maxMs:count?Math.max(...rest.map(r=>r.maxMs)):null,p50UpperMs:percentile(.5),p95UpperMs:percentile(.95),overflowAboveMs:10000,buckets},releases:[...new Set(rest.map(r=>r.release))].map(release=>({release,count:rest.filter(r=>r.release===release).reduce((n,r)=>n+r.count,0)})),purgeLagMinutes:oldest?Math.max(0,currentMinute()-65-oldest.minute):0,limits:["A covered minute proves one canary, not delivery of every request.","Crashes before response construction and partial transport loss are unmeasured.","Missing coverage is unknown, not a zero-traffic or zero-error claim.","Unknown/overflow release tags cannot support exact release comparison.","Null percentile with samples means above 10000ms; no interpolation."]};
}});
