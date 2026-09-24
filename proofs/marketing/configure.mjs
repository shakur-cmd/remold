import {docker,prefix} from './runtime.mjs';
docker(['exec',prefix+'-web-a','php','-r',`$p='/var/www/html/config/local.php'; include $p; $parameters=array_replace($parameters,['api_enabled'=>true,'api_enable_basic_auth'=>true,'mailer_from_email'=>'synthetic-sender@example.invalid','mailer_from_name'=>'Synthetic marketing proof','mailer_dsn'=>'null://null','messenger_dsn_email'=>'doctrine://default']); file_put_contents($p,"<?php\\n".chr(36).'parameters = '.var_export($parameters,true).';');`]);
docker(['exec','--user','www-data',prefix+'-web-a','php','/var/www/html/bin/console','cache:clear','--no-warmup']);
console.log('Synthetic local API enabled; null transport and durable email queue configured.');
