// Publish-time admission for public forms. Only raw capture forms pass: native mappings merge identities and drop
// do-not-contact, native actions run against contacts, and a campaign source adds the submission's contact
// (or null) to the campaign. See ownership/evidence/independent/report.html.
import {createHash} from 'node:crypto';
import {docker,prefix} from '../runtime.mjs';
import {api} from '../tenants/api.mjs';
import {TRACKING_POLICY} from './server.mjs';

export function admissionRefusals(form,campaignLinks){
 const refusals=[],inputs=(form.fields??[]).filter(f=>f.type!=='button');
 if(form.isPublished!==true)refusals.push('unpublished');
 if(form.formType!=='standalone')refusals.push('not a standalone form');
 if(Object.values(form.actions??{}).length)refusals.push('has native actions');
 for(const f of inputs)if(['mappedObject','mappedField','leadField'].some(k=>f[k]!=null&&f[k]!==''))refusals.push('mapped field '+f.alias);
 if(JSON.stringify(inputs.map(f=>[f.alias,f.type]))!==JSON.stringify([['email','email'],['firstname','text']]))refusals.push('fields are not exactly email and firstname');
 if(!Number.isSafeInteger(campaignLinks)||campaignLinks!==0)refusals.push('campaign-linked');
 return refusals;
}

export function admitForm(tenant,formId){
 if(!['a','b'].includes(tenant)||!Number.isSafeInteger(formId)||formId<1)throw Error('Unknown form');
 const response=api(tenant,'/forms/'+formId);if(response.status!==200)throw Error('Form '+formId+' refused: native read failed');
 const form=response.data.form,campaignLinks=Number(docker(['exec',prefix+'-db-'+tenant,'sh','-c','MYSQL_PWD="$MYSQL_PASSWORD" mysql -u "$MYSQL_USER" "$MYSQL_DATABASE" -NB -e "$1"','--','SELECT COUNT(*) FROM campaign_form_xref WHERE form_id='+formId]).trim());
 const refusals=admissionRefusals(form,campaignLinks);
 if(refusals.length)throw Error('Form '+formId+' on tenant '+tenant+' refused: '+refusals.join('; '));
 return {form,admission:{formId,policy:TRACKING_POLICY,campaignLinks,admittedAt:new Date().toISOString(),formSha256:createHash('sha256').update(JSON.stringify(form)).digest('hex')}};
}
