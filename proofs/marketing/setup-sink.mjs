import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {docker,directory,prefix,images} from './runtime.mjs';
export function setupSink({sender,recipient,lostResponseOnce=false}){
 const path=directory+'private/sink-key';if(!existsSync(path))writeFileSync(path,randomUUID()+randomUUID(),{mode:0o600,flag:'wx'});const key=readFileSync(path,'utf8');
 const name=prefix+'-mime-sink',volume=name;let existing=false;try{docker(['container','inspect',name]);existing=true;}catch{}
 if(existing)docker(['stop',name]);
 try{docker(['volume','inspect',volume]);}catch{docker(['volume','create','--label','remold.proof=marketing',volume]);}
 if(!existing)docker(['create','--name',name,'--label','remold.proof=marketing','--network',prefix,'--network-alias','mime-sink','--memory','128m','--mount','type=volume,src='+volume+',dst=/data','--entrypoint','node',images.mautic,'/mime-sink.mjs']);
 writeFileSync(directory+'private/sink-config.json',JSON.stringify({key,sender,recipient,lostResponseOnce}),{mode:0o600});
 for(const file of ['mime.mjs','mime-sink.mjs'])docker(['cp',directory+file,name+':/'+file]);
 docker(['cp',directory+'private/sink-config.json',name+':/config.json']);docker(['start',name]);return key;
}
