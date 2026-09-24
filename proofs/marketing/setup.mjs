import {mkdirSync,existsSync,writeFileSync,readFileSync,symlinkSync} from 'node:fs';
import {randomBytes,createHash} from 'node:crypto';
import {docker,directory,prefix,images} from './runtime.mjs';
const privateDir=directory+'private/';mkdirSync(privateDir,{recursive:true,mode:0o700});
const secret=()=>randomBytes(24).toString('hex');
const statePath=privateDir+'runtime.json';
const state=existsSync(statePath)?JSON.parse(readFileSync(statePath,'utf8')):{dbRoot:secret(),dbPassword:secret(),adminPassword:secret(),bridgeKey:secret(),instanceSecret:randomBytes(32).toString('hex')};
writeFileSync(statePath,JSON.stringify(state),{mode:0o600});
const env=(name,values)=>{const path=privateDir+name;writeFileSync(path,Object.entries(values).map(([k,v])=>k+'='+v).join('\n')+'\n',{mode:0o600});return path;};
const dbEnv=env('mysql.env',{MYSQL_ROOT_PASSWORD:state.dbRoot,MYSQL_DATABASE:'mautic_a',MYSQL_USER:'mautic_a',MYSQL_PASSWORD:state.dbPassword});
const webEnv=env('mautic-a.env',{MAUTIC_DB_HOST:'db-a',MAUTIC_DB_PORT:3306,MAUTIC_DB_DATABASE:'mautic_a',MAUTIC_DB_USER:'mautic_a',MAUTIC_DB_PASSWORD:state.dbPassword,DOCKER_MAUTIC_ROLE:'mautic_web',MAUTIC_MAILER_DSN:'null://null',MAUTIC_MESSENGER_DSN_EMAIL:'doctrine://default',MAUTIC_MESSENGER_DSN_HIT:'sync://',REMOLD_ADMIN_PASSWORD:state.adminPassword,REMOLD_BRIDGE_KEY:state.bridgeKey,REMOLD_BRIDGE_URL:'http://bridge:3542'});
const backendEnv=env('convex.env',{INSTANCE_NAME:'remold-marketing-proof',INSTANCE_SECRET:state.instanceSecret,CONVEX_CLOUD_ORIGIN:'http://127.0.0.1:3545',CONVEX_SITE_ORIGIN:'http://127.0.0.1:3546',DISABLE_BEACON:'true',DISABLE_METRICS_ENDPOINT:'true',APPLICATION_MAX_CONCURRENT_MUTATIONS:4});
function ensure(kind,name,args){try{docker([kind,'inspect',name]);}catch{docker([kind,'create',...args,name]);}}
ensure('network',prefix,['--internal','--label','remold.proof=marketing']);
for(const suffix of ['db-a','config-a','media-a','logs-a','convex'])ensure('volume',prefix+'-'+suffix,['--label','remold.proof=marketing']);
function run(name,args){try{const label=docker(['inspect','--format','{{index .Config.Labels "remold.proof"}}',name]).trim();if(label!=='marketing')throw Error('Unexpected existing resource');return;}catch(error){if(error.message==='Unexpected existing resource')throw error;}docker(['run','-d','--name',name,'--label','remold.proof=marketing','--network',prefix,...args]);}
run(prefix+'-db-a',['--network-alias','db-a','--memory','512m','--env-file',dbEnv,'--mount','type=volume,src='+prefix+'-db-a,dst=/var/lib/mysql',images.mysql,'--innodb-buffer-pool-size=64M','--max-connections=30','--performance-schema=OFF']);
run(prefix+'-authority',['--network-alias','authority','--memory','768m','--env-file',backendEnv,'-p','127.0.0.1:3545:3210','-p','127.0.0.1:3546:3211','--mount','type=volume,src='+prefix+'-convex,dst=/convex/data',images.convex]);
run(prefix+'-web-a',['--network-alias','web-a','--memory','768m','--env-file',webEnv,'-p','127.0.0.1:3540:80','--mount','type=volume,src='+prefix+'-config-a,dst=/var/www/html/config','--mount','type=volume,src='+prefix+'-media-a,dst=/var/www/html/docroot/media','--mount','type=volume,src='+prefix+'-logs-a,dst=/var/www/html/var/logs',images.mautic]);
if(!existsSync(directory+'node_modules'))symlinkSync('../../node_modules',directory+'node_modules','dir');
const evidence={level:'SERVICE setup only',images,network:prefix,internalNetwork:true,ports:{web:3540,authority:3545,site:3546},containers:[prefix+'-db-a',prefix+'-authority',prefix+'-web-a'],sourceHash:createHash('sha256').update(readFileSync(new URL('./setup.mjs',import.meta.url))).digest('hex')};
writeFileSync(directory+'evidence/runtime-setup.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence));
