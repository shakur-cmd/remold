import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {openSync,writeSync,fsyncSync,closeSync} from 'node:fs';
import {createHash} from 'node:crypto';
export function assertSameInvoice(before,after) {
    const financial = invoice => {
        for(const field of ['hosted_invoice_url','invoice_pdf']) assert(invoice[field]===null||typeof invoice[field]==='string','Invalid invoice delivery field');
        const {hosted_invoice_url,invoice_pdf,...rest}=invoice;return rest;
    };
    if(!isDeepStrictEqual(financial(before),financial(after))) throw Object.assign(new Error('Invoice changed during traversal'),{providerEvidence:{before,after}});
}
export function preserveFailure(journal,error) {
    const text=JSON.stringify({name:error?.name,message:String(error?.message??error),stack:error?.stack,providerEvidence:error?.providerEvidence,actual:error?.actual,expected:error?.expected},null,2)+'\n';
    const fd=openSync(journal.path+'.failure.json','wx',0o600);try{writeSync(fd,text);fsyncSync(fd);}finally{closeSync(fd);}
    const digest=createHash('sha256').update(text).digest('hex');journal.append({kind:'private-failure',diagnosticSha256:digest});
    return {name:['AssertionError','OutcomeUnknown','Error'].includes(error?.name)?error.name:'Error',status:Number.isInteger(error?.status)&&error.status>=100&&error.status<=599?error.status:null,category:'sandbox-stopped',diagnosticSha256:digest};
}
