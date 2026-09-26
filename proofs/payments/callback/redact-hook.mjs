// Preload with `node --import ./callback/redact-hook.mjs ...` so a local backend looks like production Convex
// to the client: errors that are not ConvexError lose their message; ConvexError data passes through.
import {ConvexHttpClient} from 'convex/browser';
for(const name of ['query','mutation','action']){
 const original=ConvexHttpClient.prototype[name];
 ConvexHttpClient.prototype[name]=async function(...args){
  try{return await original.apply(this,args);}
  catch(error){if(error?.name==='ConvexError'&&error.data!==undefined)throw error;throw new Error('[Request ID: redacted] Server Error');}
 };
}
