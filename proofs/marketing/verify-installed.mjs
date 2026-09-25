import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,writeFileSync,statSync} from 'node:fs';
import {docker,directory,prefix} from './runtime.mjs';
const files=[],hash=b=>createHash('sha256').update(b).digest('hex');
function check(local,container,remote){const expected=hash(readFileSync(directory+local));assert.equal(docker(['exec',prefix+'-'+container,'sha256sum',remote]).trim().split(/\s+/)[0],expected,local+' installed source differs');files.push({local,container,remote,sha256:expected});}
for(const file of readdirSync(directory+'plugin',{recursive:true}).filter(x=>x.endsWith('.php'))){check('plugin/'+file,'web-a','/var/www/html/docroot/plugins/RemoldGuardBundle/'+file);docker(['exec',prefix+'-web-a','php','-l','/var/www/html/docroot/plugins/RemoldGuardBundle/'+file]);}
for(const file of ['bridge.mjs','mime.mjs'])check(file,'bridge','/'+file);
for(const file of ['mime-sink.mjs','mime.mjs'])check(file,'mime-sink','/'+file);
const owner=JSON.parse(readFileSync(directory+'private/bridge-config.json')).fixture.A.sessions.owner;
const bridge=docker(['exec',prefix+'-bridge','cat','/config.json']),receiver=docker(['exec',prefix+'-mime-sink','cat','/config.json']);
assert.ok(!bridge.includes(owner)&&!receiver.includes(owner));assert.deepEqual(Object.keys(JSON.parse(receiver)).sort(),['key','lostResponseOnce','recipient','sender']);
for(const file of ['sink-key','sink-config.json','engine-config.json']){assert.equal(statSync(directory+'private/'+file).mode&0o777,0o600);}
writeFileSync(directory+'evidence/mime/installed.json',JSON.stringify({status:'PASS',capturedAt:new Date().toISOString(),files,phpSyntax:'PASS',ownerSessionAbsent:true,receiverHasNoH0Credentials:true,privateConfigMode:'0600'},null,2)+'\n');
console.log('PASS '+files.length+' installed source hashes, PHP syntax and bounded credential placement.');
