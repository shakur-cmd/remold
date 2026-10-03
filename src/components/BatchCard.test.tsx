// @vitest-environment jsdom
// Independent verification (Sol 6.1) UI repros, adopted in round 3.
import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("convex/react",()=>({useQuery:()=>({page:[],isDone:true,continueCursor:""}),useMutation:()=>async()=>({status:"dismissed"})}));
const {BatchCard}=await import("./BatchCard");
afterEach(()=>vi.useRealTimers());
const row:any={_id:"b",status:"applying",mode:"proposal",summary:"Update Stage on 2 Opportunities",reason:"tidy",total:2,counts:{create:0,update:2,delete:0},impact:null,counting:false,progress:{done:0,applied:0,conflicted:0,failed:0},agentName:"Agent",paused:false,createdAt:1000,progressAt:1000,resolvedAt:null,error:null};
it("a batch whose driver died offers Resume after one minute without another database write",async()=>{
 vi.useFakeTimers();vi.setSystemTime(1000);
 const host=document.createElement("div"),root=createRoot(host);
 await act(async()=>root.render(<MemoryRouter><BatchCard orgId={"o" as any} row={row}/></MemoryRouter>));
 expect(host.textContent).not.toContain("Resume");
 await act(async()=>{vi.advanceTimersByTime(61000);});
 try{expect(host.textContent).toContain("Resume");}finally{await act(async()=>root.unmount());}
});
it("a stopped revoked-agent batch offers Dismiss so its remaining items can be discarded",async()=>{
 const host=document.createElement("div"),root=createRoot(host);
 await act(async()=>root.render(<MemoryRouter><BatchCard orgId={"o" as any} row={{...row,status:"stopped",paused:true,error:"Agent access changed"}}/></MemoryRouter>));
 try{expect([...host.querySelectorAll("button")].map(b=>b.textContent)).toContain("Dismiss");}finally{await act(async()=>root.unmount());}
});
it("a count that failed shows Retry and holds Apply; a capped count reads N+; a hidden reason shows nothing", async()=>{
 const host=document.createElement("div"),root=createRoot(host);
 const failed={...row,status:"pending",counts:{create:0,update:0,delete:2},countError:"Could not count what deleting would clear",impact:0,reason:""};
 await act(async()=>root.render(<MemoryRouter><BatchCard orgId={"o" as any} row={failed}/></MemoryRouter>));
 try{
  const buttons=[...host.querySelectorAll("button")];
  expect(buttons.map(b=>b.textContent)).toContain("Retry");
  expect(buttons.find(b=>b.textContent==="Apply all 2")?.disabled).toBe(true);
  expect(host.textContent).not.toContain("“");
  await act(async()=>root.render(<MemoryRouter><BatchCard orgId={"o" as any} row={{...failed,countError:null,impact:500,impactPartial:true}}/></MemoryRouter>));
  expect(host.textContent).toContain("Deleting also clears 500+ links from other records.");
 }finally{await act(async()=>root.unmount());}
});
