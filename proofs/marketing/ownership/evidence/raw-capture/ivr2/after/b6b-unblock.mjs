// IV r2: unblock the poisoned A queue left by b6 poison. Settle each poison as 'ambiguous' with A's reconciler key
// (no Mautic write), showing the second poison fails on the search-size assertion on its own.
import {spawnSync} from 'node:child_process';
import * as L from './lib2.mjs';
const rec=()=>{const r=spawnSync(process.execPath,[L.directory+'rawcapture/reconcile.mjs','a'],{encoding:'utf8'});return {exit:r.status,err:(r.stderr.split('\n').find(l=>/Error/.test(l))??'').slice(0,160),out:r.stdout.trim().slice(0,300)};};
const find=async e=>(await L.inventory('a')).find(c=>c.email===e&&c.status==='pending');
const steps=[];
const p1=(await L.inventory('a')).find(c=>c.status==='pending'&&c.email.startsWith('iv%pct-'));
steps.push({settle:'iv%pct',result:await L.mutation('capture:settle',{key:L.K.a.reconciler,id:p1.id,outcome:'ambiguous'})});
steps.push({run:'after first unblock',...rec()});
const p2=await find('%@%.%');
steps.push({settle:'%@%.%',result:p2?await L.mutation('capture:settle',{key:L.K.a.reconciler,id:p2.id,outcome:'ambiguous'}):'not pending'});
steps.push({run:'after second unblock',...rec()});
steps.push({pendingLeft:(await L.inventory('a')).filter(c=>c.status==='pending').length});
L.save2('b6b-unblock',{steps});console.log(JSON.stringify(steps));
