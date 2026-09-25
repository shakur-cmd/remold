import {isMain} from './state.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {workosChange} from './policy.mjs';
import {load,save,locked} from './state.mjs';
export async function recordWorkos(directory,beforeFile,afterFile) {
 return await locked(resolve(directory),()=>{
  const {dir,receipt,plan}=load(directory);assert.equal(receipt.phase,'frontend-ready');assert.equal(receipt.workosOwned,null);
  const before=JSON.parse(readFileSync(beforeFile)),after=JSON.parse(readFileSync(afterFile));
  const intended=workosChange(plan,before,'add');
  for(const key of Object.keys(before)){if(key!=='owned')assert.deepEqual(after[key],intended[key],`Unexpected WorkOS ${key} change`);}
  receipt.workosOwned=intended.owned;receipt.workosBefore=before;receipt.workosAfter=after;receipt.phase='auth-configured';save(dir,receipt);
  return {phase:receipt.phase,owned:receipt.workosOwned};
 });
}
if(isMain(import.meta.url)){
 try{console.log(JSON.stringify(await recordWorkos(...process.argv.slice(2)),null,2));}catch(e){console.error(e.message);process.exitCode=1;}
}
