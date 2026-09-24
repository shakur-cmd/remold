import {writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {mautic} from './api.mjs';
import {directory} from './runtime.mjs';
const run=randomUUID().slice(0,8);
const contact=(await mautic('/contacts/new','POST',{email:'synthetic-'+run+'@example.invalid',firstname:'Synthetic'})).contact;
const email=(await mautic('/emails/new','POST',{name:'Synthetic '+run,subject:'Synthetic queue proof '+run,emailType:'template',isPublished:true,template:'blank',customHtml:'<html><body>Hello {contactfield=firstname}<p>Local proof only.</p>{unsubscribe_text}</body></html>',plainText:'Synthetic local proof',fromAddress:'synthetic-sender@example.invalid',fromName:'Synthetic proof'})).email;
const segment=(await mautic('/segments/new','POST',{name:'Synthetic '+run,alias:'synthetic-'+run,isPublished:true,isGlobal:true})).list;
await mautic('/segments/'+segment.id+'/contact/'+contact.id+'/add','POST',{});
const events=[{id:'new_send',name:'Native first send',type:'email.send',eventType:'action',order:1,properties:{email:email.id,email_type:'transactional',attempts:3},triggerMode:'immediate',children:['new_open'],parent:null,decisionPath:null},{id:'new_open',name:'Native open decision',type:'email.open',eventType:'decision',order:2,properties:{email:email.id},children:[],parent:'new_send',decisionPath:null}];
const canvasSettings={nodes:[{id:'lists',positionX:'100',positionY:'50'},{id:'new_send',positionX:'100',positionY:'150'},{id:'new_open',positionX:'100',positionY:'250'}],connections:[{sourceId:'lists',targetId:'new_send',anchors:{source:'leadsource',target:'top'}},{sourceId:'new_send',targetId:'new_open',anchors:{source:'bottom',target:'top'}}]};
if(process.argv.includes('--branch')){
 const second=(await mautic('/emails/new','POST',{name:'Synthetic follow-up '+run,subject:'Synthetic opened follow-up '+run,emailType:'template',isPublished:true,template:'blank',customHtml:'<html><body>Synthetic second email after a local open.</body></html>',plainText:'Synthetic second email',fromAddress:'synthetic-sender@example.invalid',fromName:'Synthetic proof'})).email;
 events[1].children=['new_second'];events.push({id:'new_second',name:'Native second send',type:'email.send',eventType:'action',order:3,properties:{email:second.id,email_type:'transactional',attempts:3},triggerMode:'immediate',children:[],parent:'new_open',decisionPath:'yes'});
 canvasSettings.nodes.push({id:'new_second',positionX:'100',positionY:'350'});canvasSettings.connections.push({sourceId:'new_open',targetId:'new_second',anchors:{source:'yes',target:'top'}});
}
const campaign=(await mautic('/campaigns/new','POST',{name:'Synthetic '+run,isPublished:true,allowRestart:true,events,forms:[],lists:[{id:segment.id}],canvasSettings})).campaign;
const value={run,contact:contact.id,email:email.id,segment:segment.id,campaign:campaign.id,events:campaign.events.map(e=>({id:e.id,type:e.type,parent:e.parent}))};
writeFileSync(directory+'private/native-fixture.json',JSON.stringify(value,null,2),{mode:0o600});
console.log(JSON.stringify(value));
