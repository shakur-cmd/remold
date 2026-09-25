import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {randomBytes,randomUUID} from 'node:crypto';
import {docker,directory,prefix,images} from '../runtime.mjs';
const privateDir=directory+'private/tenants/';mkdirSync(privateDir,{recursive:true,mode:0o700});
const statePath=privateDir+'b.json',secret=()=>randomBytes(24).toString('hex');
const state=existsSync(statePath)?JSON.parse(readFileSync(statePath)):{fixture:randomUUID(),dbRoot:secret(),dbPassword:secret(),adminPassword:secret()};
if(!existsSync(statePath))writeFileSync(statePath,JSON.stringify(state),{mode:0o600,flag:'wx'});
const network=prefix+'-tenant-b',labels=['--label','remold.proof=marketing','--label','remold.tenant=b','--label','remold.fixture='+state.fixture];
const inspect=(kind,name)=>{try{return JSON.parse(docker([kind,'inspect',name]))[0];}catch{return null;}};
function owned(value){const l=value.Labels??value.Config?.Labels;assert.equal(l?.['remold.proof'],'marketing');assert.equal(l?.['remold.tenant'],'b');assert.equal(l?.['remold.fixture'],state.fixture);}
function resource(kind,name,args){const old=inspect(kind,name);if(old){owned(old);return;}docker([kind,'create',...labels,...args,name]);}
function container(name,args,image){let v=inspect('container',name);if(v){owned(v);assert.equal(v.Config.Image,image);assert.deepEqual(Object.keys(v.NetworkSettings.Networks),[network]);if(!v.State.Running)docker(['start',name]);return;}docker(['run','-d','--name',name,...labels,'--network',network,...args,image]);}
const env=(name,values)=>{const p=privateDir+name;writeFileSync(p,Object.entries(values).map(([k,v])=>k+'='+v).join('\n')+'\n',{mode:0o600});return p;};
const db=prefix+'-db-b',web=prefix+'-web-b';
try{
 for(const image of [images.mysql,images.mautic])docker(['image','inspect',image]);
 resource('network',network,['--internal']);assert.equal(inspect('network',network).Internal,true);
 for(const suffix of ['db-b','config-b','media-b','logs-b'])resource('volume',prefix+'-'+suffix,[]);
 const dbEnv=env('mysql-b.env',{MYSQL_ROOT_PASSWORD:state.dbRoot,MYSQL_DATABASE:'mautic_b',MYSQL_USER:'mautic_b',MYSQL_PASSWORD:state.dbPassword});
 const webEnv=env('mautic-b.env',{MAUTIC_DB_HOST:'db-b',MAUTIC_DB_PORT:3306,MAUTIC_DB_DATABASE:'mautic_b',MAUTIC_DB_USER:'mautic_b',MAUTIC_DB_PASSWORD:state.dbPassword,DOCKER_MAUTIC_ROLE:'mautic_web',MAUTIC_MAILER_DSN:'null://null',MAUTIC_MESSENGER_DSN_EMAIL:'doctrine://default',MAUTIC_MESSENGER_DSN_HIT:'sync://',REMOLD_ADMIN_PASSWORD:state.adminPassword});
 container(db,['--network-alias','db-b','--memory','512m','--env-file',dbEnv,'--mount','type=volume,src='+prefix+'-db-b,dst=/var/lib/mysql'],images.mysql);
 container(web,['--network-alias','web-b','--network-alias','tenant-b.marketing-proof.invalid','--memory','768m','--env-file',webEnv,...['config','media','logs'].flatMap(x=>['--mount','type=volume,src='+prefix+'-'+x+'-b,dst='+({config:'/var/www/html/config',media:'/var/www/html/docroot/media',logs:'/var/www/html/var/logs'}[x])])],images.mautic);
 const sql=query=>docker(['exec',db,'sh','-c','MYSQL_PWD="$MYSQL_PASSWORD" mysql -u "$MYSQL_USER" "$MYSQL_DATABASE" -NB -e "$1"','--',query]).trim();
 for(let n=0;n<60;n++){try{assert.equal(sql('SELECT 1'),'1');break;}catch(e){if(n===59)throw e;await new Promise(r=>setTimeout(r,1000));}}
 const tables=Number(sql("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='mautic_b'"));
 if(tables===0){
  // --force is allowed only after proving this newly owned synthetic database contains no tables.
  const out=docker(['exec','--user','www-data',web,'sh','-c','php /var/www/html/bin/console mautic:install --force --no-interaction --admin_firstname Synthetic --admin_lastname MarketingB --admin_username proof --admin_email marketing-b@example.invalid --admin_password "$REMOLD_ADMIN_PASSWORD" http://tenant-b.marketing-proof.invalid']);
  writeFileSync(privateDir+'install-b.log',out,{mode:0o600});
 }else assert.equal(sql("SELECT COUNT(*) FROM users WHERE username='proof' AND email='marketing-b@example.invalid'"),'1','Existing B database must have its expected synthetic admin; never overwrite partial or unexpected data');
 docker(['exec',web,'php','-r',`$p='/var/www/html/config/local.php'; include $p; $parameters=array_replace($parameters,['api_enabled'=>true,'api_enable_basic_auth'=>true,'mailer_from_email'=>'synthetic-sender@example.invalid','mailer_from_name'=>'Synthetic B proof','mailer_dsn'=>'null://null','messenger_dsn_email'=>'doctrine://default']); file_put_contents($p,"<?php\\n".chr(36).'parameters = '.var_export($parameters,true).';');`]);
 writeFileSync(privateDir+'cache-b.log',docker(['exec','--user','www-data',web,'php','/var/www/html/bin/console','cache:clear','--no-warmup']),{mode:0o600});
 assert.equal(Object.keys(inspect('container',web).HostConfig.PortBindings??{}).length,0);
 state.initialized=true;writeFileSync(statePath,JSON.stringify(state),{mode:0o600});
 writeFileSync(directory+'tenants/evidence/setup-b.json',JSON.stringify({level:'SERVICE setup only; B mail discarded by null transport, no B dispatch proof',capturedAt:new Date().toISOString(),fixture:state.fixture,network,internal:true,containers:[db,web],images,publishedPorts:0,configuredMemoryMiB:1280,existingTablesAtEntry:tables,aMutationsRequested:0,aDataCompared:false},null,2)+'\n');
 console.log('B initialized with its own internal network, database, storage and credentials; no published port or mail provider.');
}catch(error){writeFileSync(privateDir+'setup-error.log',String(error.stderr??error.stack??error),{mode:0o600});throw Error('B setup stopped; private error retained. Existing A data was not changed by this script.');}
