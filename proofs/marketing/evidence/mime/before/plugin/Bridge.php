<?php
declare(strict_types=1);
namespace MauticPlugin\RemoldGuardBundle;
use Symfony\Component\Mailer\Envelope;
use Symfony\Component\Mime\Email;
use Symfony\Component\Mime\RawMessage;
final class Bridge {
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
    public static function payload(RawMessage $message,Envelope $envelope): array {
        if (!$message instanceof Email || count($envelope->getRecipients())!==1 || count($message->getTo())!==1 || $message->getCc() || $message->getBcc() || $message->getAttachments()) throw new \RuntimeException('Unsupported message shape');
        $headers=[];
        foreach ($message->getHeaders()->all() as $header) {
            $name=strtolower($header->getName());
            if (!in_array($name,['date','message-id','mime-version','content-type','content-transfer-encoding'],true)) $headers[$name][]=$header->getBodyAsString();
        }
        ksort($headers);
        $intent=$message->getHeaders()->get('X-Remold-Intent')?->getBodyAsString();
        $hash=hash('sha256',json_encode(['headers'=>$headers,'html'=>$message->getHtmlBody(),'text'=>$message->getTextBody()],JSON_THROW_ON_ERROR));
        return ['intent'=>$intent,'hash'=>$hash,'recipient'=>$envelope->getRecipients()[0]->getAddress(),'recipients'=>1];
    }
}
