import {docker,directory,prefix} from './runtime.mjs';
docker(['cp',directory+'plugin/.',prefix+'-web-a:/var/www/html/docroot/plugins/RemoldGuardBundle']);
docker(['exec',prefix+'-web-a','chown','-R','www-data:www-data','/var/www/html/docroot/plugins/RemoldGuardBundle']);
for(const command of [['cache:clear','--no-warmup'],['mautic:plugins:reload']])console.log(docker(['exec','--user','www-data',prefix+'-web-a','php','/var/www/html/bin/console',...command]));
