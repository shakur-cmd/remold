import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {docker,directory,prefix} from '../runtime.mjs';
const rows=[],privateDir=directory+'private/callbacks/',hash=b=>createHash('sha256').update(b).digest('hex');
for(const tenant of ['a','b']){
 const name=prefix+'-callback-'+tenant,network=prefix+(tenant==='b'?'-tenant-b':''),web=prefix+'-web-'+tenant;
 const installed=JSON.parse(docker(['inspect',name]))[0];assert.equal(installed.Config.Labels['remold.tenant'],tenant);assert.deepEqual(Object.keys(installed.NetworkSettings.Networks),[network]);assert.equal(installed.State.Running,true);
 const config='/var/www/html/config/local.php',backup=privateDir+'local-before-'+tenant+'.php';
 const current=docker(['exec',web,'cat',config]);
 if(!existsSync(backup))writeFileSync(backup,current,{mode:0o600,flag:'wx'});
 const before=JSON.parse(docker(['exec',web,'php','-r',`include '${config}'; echo json_encode($parameters['webhook_allowed_private_addresses']??[]);`]));
 assert.ok(Array.isArray(before));assert.ok(before.length===0||(before.length===1&&before[0]===name),'Unexpected allowlist requires reconciliation');
 if(before.length===0){
  docker(['exec',web,'php','-r',`$p='${config}';include $p;$parameters['webhook_allowed_private_addresses']=['${name}'];$tmp=$p.'.callback-next';file_put_contents($tmp,"<?php\n".chr(36).'parameters = '.var_export($parameters,true).';');chmod($tmp,fileperms($p)&0777);chown($tmp,fileowner($p));chgrp($tmp,filegroup($p));rename($tmp,$p);`]);
  writeFileSync(privateDir+'cache-'+tenant+'.log',docker(['exec','--user','www-data',web,'php','/var/www/html/bin/console','cache:clear','--no-warmup']),{mode:0o600});
 }
 const after=JSON.parse(docker(['exec',web,'php','-r',`include '${config}';echo json_encode($parameters['webhook_allowed_private_addresses']);`]));assert.deepEqual(after,[name]);
 // Compare all decoded settings without printing credentials. Only the named allowlist may change.
 docker(['cp',backup,web+':/tmp/remold-callback-before.php']);
 assert.equal(docker(['exec',web,'php','-r',`include '/tmp/remold-callback-before.php';$before=$parameters;include '${config}';unset($before['webhook_allowed_private_addresses'],$parameters['webhook_allowed_private_addresses']);if($before!==$parameters)exit(1);echo 'only allowlist changed';`]),'only allowlist changed');
 rows.push({tenant,before,after,backupSha256:hash(readFileSync(backup)),currentSha256:hash(docker(['exec',web,'cat',config])),onlyAllowlistChanged:true});
}
const output=directory+'capture/evidence/callback-allowlist.json';assert.ok(!existsSync(output),'Preserve first evidence');writeFileSync(output,JSON.stringify({at:new Date().toISOString(),rows},null,2)+'\n',{flag:'wx'});console.log('Only each tenant’s owned callback hostname was allowed; all other decoded native settings are unchanged.');
