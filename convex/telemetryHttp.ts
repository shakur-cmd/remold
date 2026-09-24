declare const process: { env: Record<string, string | undefined> };
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { RELEASE_SHA } from "./release";

export async function validProbe(request:Request):Promise<boolean>{
 const secret=process.env.REMOLD_METRICS_PROBE_SECRET;
 if(!secret||secret.length<32)return false;
 const presented=request.headers.get("authorization")??"";
 const expected=`Bearer ${secret}`;
 if(presented.length!==expected.length)return false;
 let difference=0;
 for(let i=0;i<expected.length;i++)difference|=expected.charCodeAt(i)^presented.charCodeAt(i);
 return difference===0;
}

export async function recordResponse(ctx:ActionCtx,request:Request,response:Response,startedAt:number):Promise<void>{
 const completedAt=Date.now();
 if(process.env.REMOLD_METRICS_OFF==="1")return;
 try{
  await ctx.scheduler.runAfter(0,internal.telemetry.record,{minute:Math.floor(startedAt/60_000),route:request.method==="GET"&&new URL(request.url).pathname==="/api/v1/_probe"?"probe":"rest",status:response.status,durationMs:Math.max(0,completedAt-startedAt),release:RELEASE_SHA});
 }catch{console.warn("Operational metric scheduling failed");}
}
