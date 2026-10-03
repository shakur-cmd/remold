// Independent verification (Sol 6.1, REVISE on 4ef1f92): its adversarial repros, adopted as written except where
// the coordinator decided otherwise (round 3): a reference cleared by cascade cleanup is a conflict like any other change.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { agentFor, api, objectFields, rest, userAndOrg } from "./test.helpers";
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1800000000000); });
afterEach(() => { vi.useRealTimers(); });
const finish = (w: any) => w.t.finishAllScheduledFunctions(vi.runAllTimers);
async function setup() {
 const w = await userAndOrg();
 const person = await objectFields(w.client,w.orgId,"person"), company = await objectFields(w.client,w.orgId,"company"), campaign = await objectFields(w.client,w.orgId,"campaign"), opp = await objectFields(w.client,w.orgId,"opportunity");
 const agent = await agentFor(w.client,w.orgId,{name:"Verifier"});
 const create = async (o: any, values: any) => (await w.client.mutation(api.records.create,{orgId:w.orgId,objectId:o.object._id,values:Object.fromEntries(Object.entries(values).map(([k,v])=>[o.fields[k]._id,v]))})).recordId;
 const update = async (recordId: any, o: any, values: any) => w.client.mutation(api.records.update,{orgId:w.orgId,recordId,values:Object.fromEntries(Object.entries(values).map(([k,v])=>[o.fields[k]._id,v]))});
 return {...w,person,company,campaign,opp,agent,create,update,call:rest(w.t,agent.key)};
}
it("single delete preserves a person explicitly unlinked by a human before the company was deleted", async()=>{
 const w=await setup(), c=await w.create(w.company,{name:"C"}), p=await w.create(w.person,{name:"P",company:c});
 const s=await w.call("POST","/api/v1/suggestions",{action:"delete",record:p,reason:"tidy"});
 await w.update(p,w.person,{company:null});
 await w.client.mutation(api.records.remove,{orgId:w.orgId,recordId:c});
 expect(await w.client.mutation(api.suggestions.apply,{orgId:w.orgId,suggestionId:s.json.suggestion.id})).toMatchObject({status:"conflicted"});
});
it("single delete preserves a campaign whose people a human removed before deleting that person", async()=>{
 const w=await setup(), p=await w.create(w.person,{name:"P"}), c=await w.create(w.campaign,{name:"C",people:[p]});
 const s=await w.call("POST","/api/v1/suggestions",{action:"delete",record:c,reason:"tidy"});
 await w.update(c,w.campaign,{people:[]});
 await w.client.mutation(api.records.remove,{orgId:w.orgId,recordId:p});
 expect(await w.client.mutation(api.suggestions.apply,{orgId:w.orgId,suggestionId:s.json.suggestion.id})).toMatchObject({status:"conflicted"});
});
it("batch delete skips an explicit human unlink even after deleting its former target",async()=>{
 const w=await setup(), c=await w.create(w.company,{name:"C"}), p=await w.create(w.person,{name:"P",company:c});
 const s=await w.call("POST","/api/v1/batches",{reason:"tidy",changes:[{action:"delete",record:p}]});
 await finish(w);
 await w.update(p,w.person,{company:null}); await w.client.mutation(api.records.remove,{orgId:w.orgId,recordId:c});
 await w.client.mutation(api.batches.apply,{orgId:w.orgId,batchId:s.json.batch.id}); await finish(w);
 expect((await w.call("GET",`/api/v1/batches/${s.json.batch.id}`)).json.batch.progress).toMatchObject({applied:0,conflicted:1});
});
it("agent batch status hides free-text reason after the field it describes is hidden",async()=>{
 const w=await setup(), p=await w.create(w.opp,{name:"P"});
 const s=await w.call("POST","/api/v1/batches",{reason:"The confidential amount is 987654321",changes:[{action:"update",record:p,values:{amount:987654321}}]});
 await w.t.run((ctx:any)=>ctx.db.patch(w.agent.agentId,{hiddenFieldIds:[w.opp.fields.amount._id]}));
 const result=await w.call("GET",`/api/v1/batches/${s.json.batch.id}`);
 expect(result.status).toBe(200); expect(result.json.items[0].values).toEqual({});
 expect(JSON.stringify(result.json)).not.toContain("987654321");
});
it("human batch preview hides free-text reason when unrelated confidential fields are hidden",async()=>{
 const w=await setup(), p=await w.create(w.opp,{name:"P",amount:987654321});
 await w.call("POST","/api/v1/batches",{reason:"The confidential amount is 987654321",changes:[{action:"update",record:p,values:{stage:"qualified"}}]});
 const invite=await w.client.mutation(api.invites.create,{orgId:w.orgId,role:"member"});
 const m=w.t.withIdentity({tokenIdentifier:"clerk|ivH",name:"M"}); await m.mutation(api.users.store,{}); await m.mutation(api.invites.accept,{token:invite.token});
 await w.t.run(async(ctx:any)=>{const member=(await ctx.db.query("members").collect()).find((x:any)=>x.role==="member");await ctx.db.patch(member._id,{hiddenFieldIds:[w.opp.fields.amount._id]});});
 const rows=await m.query(api.batches.list,{orgId:w.orgId}); expect(rows).toHaveLength(1);
 expect(JSON.stringify(rows)).not.toContain("987654321");
});
it("conflicts after cascade cleanup too: any difference from the reviewed snapshot is a conflict; a person re-proposes",async()=>{
 const w=await setup(), c=await w.create(w.company,{name:"C"}), p=await w.create(w.person,{name:"P",company:c});
 const s=await w.call("POST","/api/v1/suggestions",{action:"delete",record:p,reason:"tidy"});
 await w.client.mutation(api.records.remove,{orgId:w.orgId,recordId:c});
 expect(await w.client.mutation(api.suggestions.apply,{orgId:w.orgId,suggestionId:s.json.suggestion.id})).toMatchObject({status:"conflicted"});
});
it("refuses gated post and automation states on every proposal and direct item",async()=>{
 const w=await setup();
 const agent=await agentFor(w.client,w.orgId,{name:"Direct",grants:[{action:"create",objectKey:"post"},{action:"create",objectKey:"automation"}]});
 for(const direct of [false,true])for(const [object,values] of [["post",{title:"P",status:"approved"}],["post",{title:"P",status:"published",publishedLink:"https://example.invalid/p"}],["automation",{name:"A",status:"on"}]] as const){
 const r=await rest(w.t,agent.key)("POST","/api/v1/batches",{reason:"x",direct,changes:[{action:"create",object,values}]});expect(r.status).toBe(403);expect(r.json.error.items[0].index).toBe(0);
 }
});
it("refuses deleting a record holding a protected retired field",async()=>{
 const w=await setup(), p=await w.create(w.person,{name:"P",title:"Secret"});
 await w.t.run((ctx:any)=>ctx.db.patch(w.person.fields.title._id,{retired:true,protectedFromAgents:true}));
 const r=await w.call("POST","/api/v1/batches",{reason:"x",changes:[{action:"delete",record:p}]});expect(r.status).toBe(403);
});
it("approver epoch changes stop work until a current member resumes",async()=>{
 const w=await setup(), p=await w.create(w.opp,{name:"P"});
 const s=await w.call("POST","/api/v1/batches",{reason:"x",changes:[{action:"update",record:p,values:{stage:"qualified"}}]});
 await w.client.mutation(api.batches.apply,{orgId:w.orgId,batchId:s.json.batch.id});
 await w.t.run(async(ctx:any)=>{const m=(await ctx.db.query("members").collect())[0];await ctx.db.patch(m._id,{authorityEpoch:1});});
 await finish(w);expect((await w.call("GET",`/api/v1/batches/${s.json.batch.id}`)).json.batch).toMatchObject({status:"stopped",progress:{applied:0}});
 await w.client.mutation(api.batches.apply,{orgId:w.orgId,batchId:s.json.batch.id});await finish(w);
 expect((await w.call("GET",`/api/v1/batches/${s.json.batch.id}`)).json.batch).toMatchObject({status:"done",progress:{applied:1}});
});
