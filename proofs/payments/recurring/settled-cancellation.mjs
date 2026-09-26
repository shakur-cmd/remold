import {isDeepStrictEqual} from 'node:util';
import {assertSameInvoice} from './provider-evidence.mjs';
export async function settledCancellation(read,wait=()=>new Promise(resolve=>setTimeout(resolve,1000))) {
    let previous=await read();
    for(let n=1;n<8;n++) {
        await wait();const current=await read();
        let stable=isDeepStrictEqual(previous.schedule,current.schedule)&&isDeepStrictEqual(previous.subscription,current.subscription);
        try {assertSameInvoice(previous.invoice,current.invoice);}
        catch(error) {if(error.message!=='Invoice changed during traversal')throw error;stable=false;}
        if(stable)return current;
        previous=current;
    }
    throw Error('Cancelled provider objects did not settle within eight reads');
}
