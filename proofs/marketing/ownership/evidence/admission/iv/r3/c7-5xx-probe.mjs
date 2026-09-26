// IV r3: search for a strict-rule-valid email or a first name that makes Mautic answer 5xx (a persistent poison).
// Calls Mautic A directly with the same requests the reconciler makes; no captures are written here.
import * as L from './lib3.mjs';
import {validEmail} from '../../../../../publishing/server.mjs';
const r=L.run,emails=['a'+r+'@b.co','_'+r+'@example.invalid','+'+r+'@example.invalid','-'+r+'@example.invalid','a-'+r+'@1.2.3.example','a.'+r+'.b@example.invalid','A'+r+'@EXAMPLE.INVALID','a'+r+'@xn--bcher-kva.example','a'+r+'@a-b.c-d.example','x'.repeat(55-r.length)+r+'@e.io','x'.repeat(56-r.length)+r+'@e.io','a'+r+'@'+'d'.repeat(63)+'.io','null'+r+'@example.invalid','a'+r+'@localhost.localdomain','a'+r+'@example.invalid'];
const names=['Emoji 😀 name','‮RTL override','<script>alert(1)</script>','ä'.repeat(100),'x'.repeat(100),"O'Brien \"Q\"",'\\\\backslash','%s %d {{x}}','\u0000'.slice(1)+'tab\u0009'.slice(0,-1)];
const out={emails:[],names:[]};
for(const e of emails){
 const p=new URLSearchParams({limit:'100','where[0][col]':'l.email','where[0][expr]':'eq','where[0][val]':e});const look=L.api('a','/contacts?'+p);
 let create=null;if(validEmail(e)){const c=L.api('a','/contacts/new','POST',{email:e});create={status:c.status,id:c.data?.contact?.id??null,msg:c.data?.errors?.[0]?.message?.slice(0,120)??null};}
 out.emails.push({email:e.length>40?e.slice(0,20)+'…('+e.length+')':e,valid:validEmail(e),lookup:look.status,create});
}
const base=L.ok(L.api('a','/contacts/new','POST',{email:'iv-names-'+r+'@example.invalid'})).contact.id;
for(const n of names){const p=L.api('a','/contacts/'+base+'/edit','PATCH',{firstname:n});out.names.push({name:n.slice(0,30),patch:p.status,stored:p.data?.contact?.fields?.all?.firstname?.slice(0,40)??null});}
out.fiveXX=[...out.emails.filter(x=>x.lookup>=500||x.create?.status>=500),...out.names.filter(x=>x.patch>=500)];
L.save3('c7-5xx-probe',out);console.log(JSON.stringify(out,null,0));
