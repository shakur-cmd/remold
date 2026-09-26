// IV r3: drain tenant A's pending captures with the original reconciler and record outcomes for the email-rule cases.
import * as L from './lib3.mjs';
const before=await L.pendingA(),m0=L.mautic('a'),t0=Date.now(),r=await L.reconcile(),ms=Date.now()-t0,m1=L.mautic('a');
const inv=await L.inventory('a'),ids=new Set(before.map(c=>c.id)),mine=inv.filter(c=>ids.has(c.id));
const rule=mine.filter(c=>c.firstname.startsWith('Rule ')).map(c=>({case:c.firstname.slice(5),emailLength:c.email.length,outcome:c.outcome,contactId:c.contactId,reason:c.reason}));
const out={pending:before.length,exit:r.exit,err:r.err,ms,perCaptureMs:Math.round(ms/Math.max(1,before.length)),outcomes:mine.reduce((a,c)=>(a[c.outcome]=(a[c.outcome]??0)+1,a),{}),rule,mauticBefore:m0,mauticAfter:m1,pendingAfter:(await L.pendingA()).length};
L.save3('c4-drain-'+(process.argv[2]??'1'),out);console.log(JSON.stringify(out));
