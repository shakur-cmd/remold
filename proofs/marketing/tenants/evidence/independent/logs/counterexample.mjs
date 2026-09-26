// Independent test harness (not project source): runs the builder's exact manifestCode and cp -a
// with the migration's capability set against a synthetic tree in tmpfs, then mutates the copy.
import {execFileSync} from 'node:child_process';
import {manifestCode} from '../../../media-storage.mjs';
const img='mautic/mautic@sha256:0b7b0351980d061887fdffd2499f2566c5ecfd28d262f1abdf3ee1bbde24db05';
const body=manifestCode+`
const assert=require('assert'),cp=require('child_process'),results={};
fs.mkdirSync('/s/sub/deep',{recursive:true});fs.writeFileSync('/s/.hidden','h');fs.writeFileSync('/s/empty','');
fs.writeFileSync('/s/sub/f.bin',Buffer.from([0,1,2,255]));fs.symlinkSync('../missing-target','/s/sub/dangling');fs.symlinkSync('f.bin','/s/sub/rel');
fs.chownSync('/s/sub',1234,5678);fs.chmodSync('/s/sub',0o2750);fs.chownSync('/s/sub/f.bin',33,33);fs.chmodSync('/s/sub/f.bin',0o4755);
fs.lchownSync('/s/sub/rel',33,44);fs.chmodSync('/s/empty',0o600);fs.chownSync('/s',33,33);fs.chmodSync('/s',0o755);
const src=manifest('/s');results.sourceEntries=src.length;results.sourceHasSymlinks=src.filter(r=>r.type==='link').length;
results.sourceSpecialModes=src.filter(r=>r.mode>0o777).map(r=>[r.path,r.mode.toString(8)]);
cp.execFileSync('cp',['-a','/s/.','/t/']);
try{assert.deepStrictEqual(manifest('/t'),src);results.cpPreserves=true;}catch(e){results.cpPreserves=false;results.cpDiff=String(e.message).slice(0,600);}
const mutations={chmod:()=>fs.chmodSync('/t/empty',0o644),chown:()=>fs.chownSync('/t/sub/f.bin',0,0),lchown:()=>fs.lchownSync('/t/sub/rel',0,0),retarget:()=>{fs.unlinkSync('/t/sub/rel');fs.symlinkSync('other','/t/sub/rel');},bytes:()=>fs.writeFileSync('/t/.hidden','H'),extra:()=>fs.writeFileSync('/t/sub/deep/new','x'),rootMode:()=>fs.chmodSync('/t',0o775)};
results.mutationDetected={};
for(const [k,f] of Object.entries(mutations)){cp.execFileSync('sh',['-c','rm -rf /t/* /t/.[!.]*; cp -a /s/. /t/']);assert.deepStrictEqual(manifest('/t'),src);f();results.mutationDetected[k]=JSON.stringify(manifest('/t'))!==JSON.stringify(src);}
console.log(JSON.stringify(results));`;
const out=execFileSync('docker',['--context','colima-remold-proof','run','--rm','--label','remold.proof=marketing','--label','remold.independent=counterexample','--network','none','--read-only','--memory','128m','--cap-drop','ALL',...['CHOWN','DAC_OVERRIDE','FOWNER','FSETID'].flatMap(c=>['--cap-add',c]),'--security-opt','no-new-privileges','--tmpfs','/s:rw,mode=755','--tmpfs','/t:rw,mode=700','--user','0:0','--entrypoint','node',img,'-e',body],{encoding:'utf8'});
console.log(out.trim());
const r=JSON.parse(out);
const ok=r.cpPreserves&&r.sourceHasSymlinks===2&&Object.values(r.mutationDetected).every(Boolean);
console.log(ok?'COUNTEREXAMPLE_CHECK PASS':'COUNTEREXAMPLE_CHECK FAIL');process.exit(ok?0:1);
