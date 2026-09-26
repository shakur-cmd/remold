import assert from 'node:assert/strict';
export const OWNER='shakur@envoylogic.com';
const times=(start,end)=>({start:{dateTime:`2026-09-25T${start}:00-04:00`,timeZone:'America/New_York'},end:{dateTime:`2026-09-25T${end}:00-04:00`,timeZone:'America/New_York'}});
export const INITIAL=times('11:00','11:15'),MOVED=times('11:30','11:45');
export function validateCalendarPlan(plan){
 assert.equal(plan.calendar,'primary');assert.equal(plan.owner,OWNER);assert.equal(plan.maxCreatedEvents,1);assert.equal(plan.sendUpdates,'none');
 assert.match(plan.id,/^remold[a-f0-9]{32}$/);assert.equal(plan.summary,'Remold integration TEST');
 assert.deepEqual(plan.initial,INITIAL);assert.deepEqual(plan.moved,MOVED);assert.deepEqual(plan.attendees,[]);
}
function ownEvent(plan,event){
 assert.equal(event.id,plan.id);assert.equal(event.summary,plan.summary);assert.equal(event.organizer?.email,OWNER);
 assert.equal(event.extendedProperties?.private?.remoldProof,plan.id);assert.equal(event.attendees?.length??0,0);assert.ok(event.etag);
 return event;
}
function atTime(event,times){for(const key of ['start','end'])assert.equal(Date.parse(event[key].dateTime),Date.parse(times[key].dateTime));}
export async function runCalendar({plan,request,record}){
 validateCalendarPlan(plan);
 const path='/calendars/primary/events',exact=path+'/'+plan.id;
 await record('create-intent',{id:plan.id});
 let created;
 try{const response=await request('POST',path+'?sendUpdates=none',{id:plan.id,summary:plan.summary,description:'Owner-authorized one-event integration test; no guests.',...plan.initial,attendees:[],reminders:{useDefault:false},extendedProperties:{private:{remoldProof:plan.id}}});if(response.status!==200)throw new Error('CREATE_UNCONFIRMED');created=response.body;}
 catch{const found=await request('GET',exact);if(found.status!==200)throw new Error('CREATE_OUTCOME_UNKNOWN');created=found.body;}
 ownEvent(plan,created);atTime(created,plan.initial);await record('created',{id:created.id,etag:created.etag});
 let response=await request('GET',exact);assert.equal(response.status,200);let event=ownEvent(plan,response.body);atTime(event,plan.initial);
 await record('reschedule-intent',{id:event.id,etag:event.etag});
 response=await request('PATCH',exact+'?sendUpdates=none',plan.moved,{'If-Match':event.etag});assert.equal(response.status,200);ownEvent(plan,response.body);atTime(response.body,plan.moved);
 response=await request('GET',exact);assert.equal(response.status,200);event=ownEvent(plan,response.body);atTime(event,plan.moved);await record('rescheduled',{id:event.id,etag:event.etag});
 await record('delete-intent',{id:event.id,etag:event.etag});
 let deleteStatus;try{deleteStatus=(await request('DELETE',exact+'?sendUpdates=none',undefined,{'If-Match':event.etag})).status;}catch{deleteStatus=null;}
 response=await request('GET',exact);
 const missing=[404,410].includes(response.status),tombstone=response.status===200&&response.body?.id===plan.id&&response.body?.status==='cancelled';
 assert.ok(missing||tombstone,'TEST_EVENT_STILL_PRESENT');
 await record('deleted',{id:event.id,deleteStatus,verificationStatus:response.status,tombstone});
 return{created:1,rescheduled:1,deleted:1,activeTestEventsRemaining:0,attendees:0,sendUpdates:'none',deleteVerification:missing?'missing':'cancelled tombstone'};
}
