// IV r2 attack 3: SIGKILL the real deployed edge container, then the raw-capture backend, mid-burst on tenant A.
// The client runs in web-a and reaches the edge over the internal network. Afterwards every failed post is retried
// with the same body (same nonce), as a browser retry would. Invariant: every 200 is durably stored, and each nonce
// ends with exactly one capture.
import {execFileSync} from 'node:child_process';
import * as L from './lib2.mjs';
const t='a',which=process.argv[2];if(!['edge','capture'].includes(which))throw Error('edge|capture');
const N=Number(process.argv[3]??48),victim=which==='edge'?L.prefix+'-public-'+t:L.prefix+'-capture';
const ip=()=>JSON.parse(L.docker(['inspect',L.prefix+'-capture']))[0].NetworkSettings.Networks[L.prefix].IPAddress;
const ipBefore=ip(),m0=L.mautic(t),inv0=(await L.inventory(t)).map(c=>c.id);
const nonces=Array.from({length:N},()=>L.nonce()),bodies=nonces.map((n,i)=>L.body(t,'iv-r2kill-'+L.run+'-'+(i%4)+'@example.invalid','Kill '+which+' '+i,n));
const input=b=>({hostname:L.prefix+'-public-'+t,port:8080,host:L.host(t),bodies:b});
let killedAt=null;
const res=await L.burst(L.prefix+'-web-'+t,input(bodies),()=>{killedAt=new Date().toISOString();execFileSync('docker',['--context',L.context,'kill',victim]);});
const startedAt=new Date().toISOString();L.docker(['start',victim]);
// Wait for the edge to answer again (it needs the backend too when the backend was killed).
const waitUp=async()=>{for(let i=0;i<90;i++){try{const r=L.rawRequests(t,[`GET /form/intake HTTP/1.1\r\nHost: ${L.host(t)}\r\nConnection: close\r\n\r\n`])[0].statuses[0];if(r===200){if(which==='edge')return true;await L.inventory(t);return true;}}catch{}await new Promise(r=>setTimeout(r,1000));}return false;};
const up=await waitUp();
const statuses=res.map(r=>r.status),acked=res.filter(r=>r.status===200).map(r=>r.i);
const invMid=await L.inventory(t),storedMid=nonces.map(n=>invMid.filter(c=>c.idempotencyKey===n).length);
const lostAcked=acked.filter(i=>storedMid[i]!==1),storedUnacked=res.filter(r=>r.status!==200&&storedMid[r.i]===1).map(r=>r.i);
const failed=res.filter(r=>r.status!==200).map(r=>r.i);
const retry=failed.length?await L.burst(L.prefix+'-web-'+t,input(failed.map(i=>bodies[i]))):[];
const invEnd=await L.inventory(t),storedEnd=nonces.map(n=>invEnd.filter(c=>c.idempotencyKey===n).length),m1=L.mautic(t);
const out={which,n:N,victim,killedAt,startedAt,backUp:up,ipBefore,ipAfter:ip(),statuses:res.map(r=>r.status+':'+r.body.slice(0,24)),acked:acked.length,ackedButNotStored:lostAcked,storedButNotAcked:storedUnacked,retryStatuses:retry.map(r=>r.status),finalPerNonce:storedEnd,mauticBefore:m0,mauticAfter:m1,
 verdict:{noAckedLoss:lostAcked.length===0,retriesAll200:retry.every(r=>r.status===200),exactlyOnePerNonce:storedEnd.every(x=>x===1),noOtherRows:invEnd.filter(c=>!inv0.includes(c.id)).length===N,mauticUnchanged:JSON.stringify(m0)===JSON.stringify(m1),forwardTargetUnchanged:ipBefore===ip()}};
L.save2('b3-kill-'+which+'-'+N,out);
console.log(JSON.stringify({acked:out.acked,failed:failed.length,storedButNotAcked:storedUnacked.length,lostAcked,retry:out.retryStatuses.join(''),verdict:out.verdict,sample:[...new Set(out.statuses)]}));
