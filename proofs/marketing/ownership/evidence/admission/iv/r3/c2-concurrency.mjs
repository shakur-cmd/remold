// IV r2 attack 2: concurrency through the deployed edges, both tenants at once. N distinct nonces per tenant, then
// 16 posts racing on one nonce with identical values, then 8 racing on one nonce with different values.
import * as L from './lib3.mjs';
const N=Number(process.argv[2]??24),out={n:N,tenants:{}};
const prep={};
for(const t of ['a']){
 const owner=L.makeOwner(t,'r2conc'),newEmail='iv-r2new-'+L.run+'@example.invalid',same=L.nonce(),diff=L.nonce();
 const distinct=Array.from({length:N},(_,i)=>L.body(t,i%2?newEmail:owner.email,'Conc '+i,L.nonce()));
 const sameBodies=Array.from({length:16},()=>L.body(t,newEmail,'Same nonce same values',same));
 const diffBodies=Array.from({length:8},(_,i)=>L.body(t,newEmail,'Same nonce value '+i,diff));
 prep[t]={owner,same,diff,distinct,p0:L.profile(t,owner.id),m0:L.mautic(t),inv0:(await L.inventory(t)).map(c=>c.id)};
 prep[t].input=b=>({hostname:'127.0.0.1',port:8080,host:L.host(t),bodies:b});
}
const t0=Date.now();
const res=await Promise.all(['a'].map(t=>L.burst(L.prefix+'-public-'+t,prep[t].input(prep[t].distinct))));
const wall=Date.now()-t0;
const res2=await Promise.all(['a'].map(t=>L.burst(L.prefix+'-public-'+t,prep[t].input([...Array.from({length:16},()=>L.body(t,'iv-r2new-'+L.run+'@example.invalid','Same nonce same values',prep[t].same)),...Array.from({length:8},(_,i)=>L.body(t,'iv-r2new-'+L.run+'@example.invalid','Same nonce value '+i,prep[t].diff))]))));
for(const [i,t] of ['a'].entries()){
 const P=prep[t],inv=await L.inventory(t),added=inv.filter(c=>!P.inv0.includes(c.id)),m1=L.mautic(t),p1=L.profile(t,P.owner.id);
 const distinctStatuses=res[i].map(r=>r.status),sameStatuses=res2[i].slice(0,16).map(r=>r.status),diffStatuses=res2[i].slice(16).map(r=>r.status);
 const sameRows=added.filter(c=>c.idempotencyKey===P.same),diffRows=added.filter(c=>c.idempotencyKey===P.diff);
 const winner=diffRows[0]?.firstname,winnerIdx=winner?Number(winner.split(' ').pop()):null;
 out.tenants[t]={distinctStatuses,maxMs:Math.max(...res[i].map(r=>r.ms)),sameStatuses,diffStatuses,added:added.length,sameRows:sameRows.length,diffRows:diffRows.map(c=>c.firstname),mauticBefore:P.m0,mauticAfter:m1,
  verdict:{distinctAll200:distinctStatuses.every(s=>s===200),distinctStored:added.length===N+2,sameAll200OneRow:sameStatuses.every(s=>s===200)&&sameRows.length===1,diffOneWinner:diffRows.length===1&&diffStatuses.filter(s=>s===200).length===1&&diffStatuses.filter(s=>s===409).length===7&&diffStatuses[winnerIdx]===200,mauticUnchanged:JSON.stringify(P.m0)===JSON.stringify(m1),ownerUnchanged:JSON.stringify(P.p0)===JSON.stringify(p1)}};
 console.log(t,JSON.stringify(out.tenants[t].verdict),'distinct',distinctStatuses.join(''),'same',sameStatuses.join(','),'diff',diffStatuses.join(','),'maxms',out.tenants[t].maxMs,'wall',wall);
}
L.save3('c2-concurrency-a-'+N,out);
