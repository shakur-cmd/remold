import test from 'node:test';
import assert from 'node:assert/strict';
import {admissionRefusals} from './admission.mjs';
const raw=()=>({isPublished:true,formType:'standalone',actions:[],fields:[{alias:'email',type:'email',mappedObject:null,mappedField:null,leadField:null},{alias:'firstname',type:'text',mappedObject:null,mappedField:null,leadField:null},{alias:'submit',type:'button'}]});
test('an unmapped, action-free, campaign-free raw form is admitted',()=>assert.deepEqual(admissionRefusals(raw(),0),[]));
test('a form that maps any field to a contact is refused',()=>{
 for(const [key,value] of [['mappedField','email'],['mappedObject','contact'],['leadField','firstname']]){const form=raw();form.fields[1][key]=value;assert.deepEqual(admissionRefusals(form,0),['mapped field firstname']);}
});
test('a form with any native action is refused, in list or keyed shape',()=>{
 for(const actions of [[{type:'lead.remove_do_not_contact'}],{7:{type:'lead.pointschange'}}])assert.deepEqual(admissionRefusals({...raw(),actions},0),['has native actions']);
});
test('a campaign-linked form or an unknown link count is refused',()=>{
 for(const links of [1,NaN,undefined])assert.deepEqual(admissionRefusals(raw(),links),['campaign-linked']);
});
test('unpublished, non-standalone or differently shaped forms are refused',()=>{
 assert.deepEqual(admissionRefusals({...raw(),isPublished:false},0),['unpublished']);
 assert.deepEqual(admissionRefusals({...raw(),formType:'campaign'},0),['not a standalone form']);
 const extra=raw();extra.fields.splice(2,0,{alias:'phone',type:'tel'});assert.deepEqual(admissionRefusals(extra,0),['fields are not exactly email and firstname']);
});
