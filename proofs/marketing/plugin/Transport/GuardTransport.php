<?php
declare(strict_types=1);
namespace MauticPlugin\RemoldGuardBundle\Transport;
use MauticPlugin\RemoldGuardBundle\Bridge;
use Symfony\Component\Mailer\Transport\AbstractTransport;
use Symfony\Component\Mailer\SentMessage;
use Symfony\Component\Mailer\Exception\TransportException;
final class GuardTransport extends AbstractTransport {
    public function __toString(): string { return 'remold://bridge'; }
    protected function doSend(SentMessage $message): void {
        try {
            $payload=Bridge::payload($message->getOriginalMessage(),$message->getEnvelope());
            $permit=Bridge::call('/authorize',$payload);
        } catch (\Throwable $e) { throw new TransportException('Current exact Remold permit refused',0,$e); }
        if (($permit['kill']??false)===true) posix_kill(getmypid(),9);
        try { Bridge::call('/sink',$payload); }
        catch (\Throwable $e) { throw new TransportException('Synthetic sink outcome unconfirmed; consumed intent remains held',0,$e); }
    }
}
