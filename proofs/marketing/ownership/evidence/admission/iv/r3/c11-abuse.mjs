// IV r3: quantify N-1 abuse on tenant A. Ingest rate through the deployed edge (no rate limit), store growth, and
// reconciler throughput from c4-drain. Posts use distinct fresh emails, as an abuser would.
import * as L from './lib3.mjs';
const N=Number(process.argv[2]??300),batch=50,du=()=>Number(L.docker(['exec',L.prefix+'-capture','sh','-c','du -sk /convex/data | cut -f1']).trim());
const inv0=(await L.inventory('a')).length,du0=du(),m0=L.mautic('a'),t0=Date.now(),statuses=[];
for(let i=0;i<N;i+=batch)statuses.push(...await L.postA(Array.from({length:Math.min(batch,N-i)},(_,j)=>({email:'iv-abuse-'+L.run+'-'+(i+j)+'@example.invalid',firstname:'Abuse '+(i+j)}))));
const ms=Date.now()-t0,inv1=(await L.inventory('a')).length,du1=du(),m1=L.mautic('a');
const out={n:N,batch,accepted:statuses.filter(s=>s===200).length,ms,postsPerSecond:+(N/(ms/1000)).toFixed(1),capturesAdded:inv1-inv0,inventoryTotal:inv1,inventoryBound:2000,storeKbBefore:du0,storeKbAfter:du1,kbPerCapture:+((du1-du0)/N).toFixed(2),mauticUnchanged:JSON.stringify(m0)===JSON.stringify(m1),captureMem:L.docker(['stats','--no-stream','--format','{{.MemUsage}}',L.prefix+'-capture']).trim()};
L.save3('c11-abuse-ingest',out);console.log(JSON.stringify(out));
