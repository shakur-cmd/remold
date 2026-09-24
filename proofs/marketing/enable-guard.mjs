import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {docker,directory,prefix,images} from './runtime.mjs';
const name=prefix+'-web-a',before=name+'-before-guard';
const label=docker(['inspect','--format','{{index .Config.Labels "remold.proof"}}',name]).trim();
if(label!=='marketing')throw Error('Not an owned marketing container');
const address=n=>docker(['inspect','--format','{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',n]).trim();
const oldIp=address(name);
const env=readFileSync(directory+'private/mautic-a.env','utf8').replace('MAUTIC_MAILER_DSN=null://null','MAUTIC_MAILER_DSN=remold://bridge');
writeFileSync(directory+'private/mautic-guard.env',env,{mode:0o600});
// Preserve the stopped before container; all synthetic persistent data stays in its own volumes.
docker(['stop',name]);docker(['rename',name,before]);
docker(['run','-d','--name',name,'--label','remold.proof=marketing','--network',prefix,'--network-alias','web-a','--memory','768m','--env-file',directory+'private/mautic-guard.env','-p','127.0.0.1:3540:80','--mount','type=volume,src='+prefix+'-config-a,dst=/var/www/html/config','--mount','type=volume,src='+prefix+'-media-a,dst=/var/www/html/docroot/media','--mount','type=volume,src='+prefix+'-logs-a,dst=/var/www/html/var/logs',images.mautic]);
const ssh=['-F',process.env.HOME+'/.colima/_lima/colima-remold-proof/ssh.config'];
execFileSync('ssh',[...ssh,'-O','cancel','-L','127.0.0.1:3540:'+oldIp+':80','lima-colima-remold-proof'],{stdio:'pipe'});
execFileSync('ssh',[...ssh,'-N','-o','ExitOnForwardFailure=yes','-L','127.0.0.1:3540:'+address(name)+':80','-L','127.0.0.1:3542:'+address(prefix+'-bridge')+':3542','lima-colima-remold-proof'],{stdio:'pipe'});
execFileSync(process.execPath,[directory+'install-plugin.mjs'],{stdio:'pipe'});
console.log('Only isolated marketing web replaced; baseline stopped and retained; final transport remold://bridge.');
