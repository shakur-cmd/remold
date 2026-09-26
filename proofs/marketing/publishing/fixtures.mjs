import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync,existsSync,renameSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {docker,directory,prefix} from '../runtime.mjs';
import {api} from '../tenants/api.mjs';
const privateDir=directory+'private/publishing/';mkdirSync(privateDir,{recursive:true,mode:0o700});
const statePath=privateDir+'fixtures.json';
const state=existsSync(statePath)?JSON.parse(readFileSync(statePath)):{fixture:randomUUID(),tenants:{a:{},b:{}}};
function save(){writeFileSync(statePath+'.tmp',JSON.stringify(state),{mode:0o600});renameSync(statePath+'.tmp',statePath);}
if(!existsSync(statePath))writeFileSync(statePath,JSON.stringify(state),{mode:0o600,flag:'wx'});
const ok=r=>{assert.ok(r.status>=200&&r.status<300,'Native API did not return success');return r.data;};
function ensure(tenant,kind,singular,payload,key=kind+'Id'){
 const binding=state.tenants[tenant],field=kind==='forms'?'name':'title';
 if(binding[key]){const entity=ok(api(tenant,'/'+kind+'/'+binding[key]))[singular];assert.equal(entity[field],payload[field]);return entity;}
 // Intent name was saved before the first POST. An accepted response loss is recovered by exact fixture name.
 const list=ok(api(tenant,'/'+kind+'?limit=100'));assert.ok(Number(list.total)<=100,'Do not silently truncate recovery inventory');
 const matches=Object.values(list[kind]).filter(e=>e[field]===payload[field]);assert.ok(matches.length<=1,'Ambiguous remote creation requires review');
 const entity=matches[0]??ok(api(tenant,'/'+kind+'/new','POST',payload))[singular];assert.ok(Number.isSafeInteger(entity.id));assert.equal(entity[field],payload[field]);binding[key]=entity.id;save();return entity;
}
const evidence={capturedAt:new Date().toISOString(),level:'SERVICE native form/page/asset registration, no public edge or delivery proof',fixture:state.fixture,tenants:{}};
for(const tenant of ['a','b']){
 const marker='Remold '+state.fixture+' '+tenant.toUpperCase(),binding=state.tenants[tenant];
 const filename='remold-publishing-'+state.fixture+'-'+tenant+'.txt',body=marker+' asset bytes\n',sha256=createHash('sha256').update(body).digest('hex');
 docker(['exec','--user','www-data',prefix+'-web-'+tenant,'node','-e',`const fs=require('fs'),crypto=require('crypto');const p=process.argv[1],body=process.argv[2];if(!fs.existsSync(p))fs.writeFileSync(p,body,{flag:'wx'});if(fs.readFileSync(p,'utf8')!==body)throw Error('Retained fixture file changed; never overwrite');`, '/var/www/html/docroot/media/files/'+filename,body]);
 const asset=ensure(tenant,'assets','asset',{title:marker+' asset',file:filename,storageLocation:'local',isPublished:true});
 const form=ensure(tenant,'forms','form',{name:marker+' form',formType:'standalone',isPublished:true,postAction:'return',postActionProperty:'Synthetic form received',fields:[{label:'Email',type:'email',alias:'email',mappedObject:'contact',mappedField:'email',showLabel:true,isRequired:true},{label:'First name',type:'text',alias:'firstname',mappedObject:'contact',mappedField:'firstname',showLabel:true},{label:'Submit',type:'button',alias:'submit'}],actions:[]});
 const page=ensure(tenant,'pages','page',{title:marker+' page',alias:'remold-'+state.fixture+'-'+tenant,isPublished:true,template:'blank',customHtml:'<!doctype html><html><head><title>'+marker+'</title></head><body><h1>'+marker+'</h1>{form='+form.id+'}</body></html>'});
 const publicPage=ensure(tenant,'pages','page',{title:marker+' public page',alias:'remold-public-'+state.fixture+'-'+tenant,isPublished:true,template:'blank',customHtml:'<!doctype html><html><head><title>'+marker+'</title></head><body><h1>'+marker+'</h1><p>Local publishing proof.</p><a href="/form/'+form.id+'">Open form</a></body></html>'},'publicPagesId');
 assert.equal(asset.isPublished,true);assert.equal(form.isPublished,true);assert.equal(page.isPublished,true);
 assert.equal(Object.values(form.actions).length,0,'Public fixture must not attach email or other native actions');
 binding.filename=filename;binding.assetSha256=sha256;binding.formAlias=form.alias;binding.pageAlias=page.alias;binding.publicPageAlias=publicPage.alias;binding.assetDownloadUrl=asset.downloadUrl;save();
 evidence.tenants[tenant]={formId:form.id,formAlias:form.alias,pageId:page.id,pageAlias:page.alias,publicPageId:publicPage.id,publicPageAlias:publicPage.alias,assetId:asset.id,assetSha256:sha256,assetDownloadUrl:asset.downloadUrl,allPublished:true,formActions:form.actions.length,limits:'Fixture files created locally then registered by native API; no upload UI or public routing claim'};
}
for(const key of ['formsId','pagesId','assetsId'])assert.equal(state.tenants.a[key],state.tenants.b[key],'Fixture requires same numeric IDs across independent tenants');
writeFileSync(directory+'publishing/evidence/fixtures.json',JSON.stringify(evidence,null,2)+'\n');
console.log('PASS native A/B forms, pages and assets exist with same numeric IDs and separate content; no form email actions.');
