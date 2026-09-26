import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {docker,prefix} from '../runtime.mjs';
import {api} from '../tenants/api.mjs';
import {request} from '../publishing/http.mjs';
export function receipts(tenant){
 assert.ok(['a','b'].includes(tenant));
 return JSON.parse(docker(['exec',prefix+'-callback-'+tenant,'node','--input-type=module','-e',"import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync('/data/receipts.sqlite',{readOnly:true});console.log(JSON.stringify(db.prepare('SELECT * FROM receipts ORDER BY received_at, sha256').all()));db.close();"]));
}
export function submit(tenant,email='capture-'+randomUUID()+'@example.invalid',firstname='Capture proof'){
 assert.ok(['a','b'].includes(tenant));assert.match(email,/^capture-[a-f0-9-]+@example\.invalid$/);
 const host='tenant-'+tenant+'.marketing-proof.invalid',options={host,container:'public',port:8080,path:'/form/1'};
 const form=request(tenant,options);assert.equal(form.status,200);const token=form.body.toString().match(/name="t" value="([a-f0-9]{64})"/)[1];
 const response=request(tenant,{...options,method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email,firstname,t:token}).toString()});
 const found=api(tenant,'/contacts?limit=100&search='+encodeURIComponent(email));assert.equal(found.status,200);
 const contacts=Object.values(found.data.contacts).filter(c=>c.fields.all.email===email);assert.equal(contacts.length,1,'Read back actual native capture, regardless of HTTP acknowledgement');
 return {status:response.status,body:response.body.toString(),email,contactId:contacts[0].id,firstname:contacts[0].fields.all.firstname};
}
