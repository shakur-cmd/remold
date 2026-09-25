import {createHash} from 'node:crypto';import {writeFileSync} from 'node:fs';
import {api} from '/Users/urkel/Documents/CodeMyVibe/Projects/remold/proofs/marketing/tenants/api.mjs';
const h=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');const ids={a:[1,2,3,4,5],b:[1,2,3]},out={};
for(const t of ['a','b'])out[t]=Object.fromEntries(ids[t].map(i=>{const f=api(t,'/forms/'+i).data.form;return [i,h(f)];}));
writeFileSync(process.argv[2],JSON.stringify(out,null,1)+'\n');console.log(JSON.stringify(out));
