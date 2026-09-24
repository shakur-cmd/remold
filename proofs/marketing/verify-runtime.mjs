import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {docker,directory,prefix,images} from './runtime.mjs';
const approved=JSON.parse(readFileSync(directory+'evidence/h0-source.json','utf8'));
for(const [path,hash]of Object.entries(approved.copies))assert.equal(createHash('sha256').update(readFileSync(directory+path)).digest('hex'),hash,'Frozen H0 source changed: '+path);
assert.equal(JSON.parse(readFileSync(directory+'node_modules/convex/package.json','utf8')).version,'1.46.0');
for(const [name,image]of [['web-a',images.mautic],['db-a',images.mysql],['authority',images.convex],['bridge',images.mautic]]){
 assert.equal(docker(['inspect','--format','{{.Config.Image}}',prefix+'-'+name]).trim(),image,'Unexpected runtime image');
 assert.equal(docker(['inspect','--format','{{index .Config.Labels "remold.proof"}}',prefix+'-'+name]).trim(),'marketing');
}
assert.equal(docker(['network','inspect','--format','{{.Internal}}',prefix]).trim(),'true');
console.log('PASS exact H0 source, SDK version, pinned runtime images and isolated network.');
