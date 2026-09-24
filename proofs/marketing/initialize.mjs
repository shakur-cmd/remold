import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {docker,directory,prefix} from './runtime.mjs';
const root=new URL('../../',import.meta.url).pathname;
const hash=path=>existsSync(path)?createHash('sha256').update(readFileSync(path)).digest('hex'):null;
const before=hash(root+'.env.local');
try{
 const key=docker(['exec',prefix+'-authority','./generate_admin_key.sh']).trim();
 if(!key||key.includes('\n'))throw Error('Unexpected local admin key response');
 writeFileSync(directory+'.env.local','CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3545\nCONVEX_SELF_HOSTED_ADMIN_KEY='+key+'\n',{mode:0o600});
 const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,CI:'1',CONVEX_DISABLE_METRICS:'1',CONVEX_SELF_HOSTED_URL:'http://127.0.0.1:3545',CONVEX_SELF_HOSTED_ADMIN_KEY:key};
 const out=execFileSync(process.execPath,[root+'node_modules/convex/bin/main.js','dev','--once','--typecheck','enable'],{cwd:directory,env,encoding:'utf8',stdio:['ignore','pipe','pipe']});
 writeFileSync(directory+'private/authority-initialize.log',out,{mode:0o600});
 const install=docker(['exec','--user','www-data',prefix+'-web-a','sh','-c','php /var/www/html/bin/console mautic:install --force --no-interaction --admin_firstname Synthetic --admin_lastname Marketing --admin_username proof --admin_email marketing-a@example.invalid --admin_password "$REMOLD_ADMIN_PASSWORD" http://localhost:3540']);
 writeFileSync(directory+'private/mautic-install.log',install,{mode:0o600});
 console.log('Isolated H0 authority and synthetic Mautic admin initialized.');
}catch(error){writeFileSync(directory+'private/initialize-error.log',String(error.stderr??error.message),{mode:0o600});throw Error('Initialization failed; private log retained.');}
finally{if(hash(root+'.env.local')!==before)throw Error('Root environment changed');}
