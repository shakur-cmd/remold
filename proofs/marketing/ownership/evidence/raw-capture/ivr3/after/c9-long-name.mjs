// IV r3: an attacker-controlled first name the edge accepts (<=100) but Mautic refuses on the name PATCH (>64).
import * as L from './lib3.mjs';
const out={runs:[]},rows=[64,65,100].map(n=>({email:'iv-name'+n+'-'+L.run+'@example.invalid',firstname:'N'.repeat(n)}));
const good={email:'iv-after-name-'+L.run+'@example.invalid',firstname:'Good'};
out.posts=await L.postA([rows[1]]);out.posts.push(...await L.postA([rows[2]]),...await L.postA([rows[0]]),...await L.postA([good]));
for(let i=0;i<4;i++){const r=await L.reconcile();const inv=await L.inventory('a');out.runs.push({exit:r.exit,err:r.err,states:[...rows,good].map(x=>{const c=inv.find(y=>y.email===x.email);return [x.firstname.length,c?.status,c?.outcome];})});if(r.exit===0)break;}
out.contacts=[...rows,good].map(x=>({len:x.firstname.length,contacts:L.withEmail('a',x.email).map(c=>({id:c.id,nameLength:(c.firstname??"").length}))}));
L.save3('c9-long-name',out);console.log(JSON.stringify(out));
