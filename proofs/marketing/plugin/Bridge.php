<?php
declare(strict_types=1);
namespace MauticPlugin\RemoldGuardBundle;
use Symfony\Component\Mailer\Envelope;
use Symfony\Component\Mime\Email;
use Symfony\Component\Mime\RawMessage;
final class Bridge {
    public static function probe(string $stage,string $raw,?string $intent,Envelope $envelope): void {
        if (getenv('REMOLD_MIME_PROBE')!=='1') return;
        $path='/var/www/html/var/logs/remold-mime-probe.jsonl';
        $value=['stage'=>$stage,'intent'=>$intent,'raw'=>base64_encode($raw),'sender'=>$envelope->getSender()->getAddress(),'recipients'=>array_map(fn($a)=>$a->getAddress(),$envelope->getRecipients())];
        $file=fopen($path,'ab');if ($file===false) throw new \RuntimeException('Private MIME probe unavailable');
        try {chmod($path,0600);if (!flock($file,LOCK_EX) || fwrite($file,json_encode($value,JSON_THROW_ON_ERROR)."\n")===false) throw new \RuntimeException('Private MIME probe failed');fflush($file);flock($file,LOCK_UN);} finally {fclose($file);}
    }
    public static function call(string $path,array $value): array {
        $context=stream_context_create(['http'=>['method'=>'POST','timeout'=>5,'ignore_errors'=>true,'header'=>"Content-Type: application/json\r\nX-Remold-Key: ".getenv('REMOLD_BRIDGE_KEY'), 'content'=>json_encode($value,JSON_THROW_ON_ERROR)]]);
        // Only a definite pre-effect busy response permits a bounded same-call retry.
        for ($attempt=0;$attempt<3;$attempt++) {
            $http_response_header=[];
            $raw=@file_get_contents(getenv('REMOLD_BRIDGE_URL').$path,false,$context);
            if (!str_contains($http_response_header[0]??'',' 503 ') || $attempt===2) break;
            usleep(100000);
        }
        if ($raw===false || !str_contains($http_response_header[0]??'',' 200 ')) throw new \RuntimeException('Remold bridge refused or unavailable');
        return json_decode($raw,true,flags:JSON_THROW_ON_ERROR);
    }
    public static function payload(RawMessage $message,Envelope $envelope,?string $raw=null): array {
        if (!$message instanceof Email || count($envelope->getRecipients())!==1 || count($message->getTo())!==1 || $message->getCc() || $message->getBcc() || $message->getAttachments()) throw new \RuntimeException('Unsupported message shape');
        $intent=$message->getHeaders()->get('X-Remold-Intent')?->getBodyAsString();
        return ['intent'=>$intent,'raw'=>base64_encode($raw??$message->toString()),'sender'=>$envelope->getSender()->getAddress(),'recipient'=>$envelope->getRecipients()[0]->getAddress(),'recipients'=>1];
    }
}
