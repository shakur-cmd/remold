<?php
declare(strict_types=1);
namespace MauticPlugin\RemoldGuardBundle\EventListener;
use Mautic\CampaignBundle\Event\PendingEvent;
use Mautic\EmailBundle\EmailEvents;
use Mautic\EmailBundle\Event\EmailSendEvent;
use Symfony\Component\EventDispatcher\EventSubscriberInterface;
use Symfony\Component\Mailer\Event\MessageEvent;
use Symfony\Component\Mailer\Event\SentMessageEvent;
use Symfony\Component\Mailer\Event\FailedMessageEvent;
use MauticPlugin\RemoldGuardBundle\Bridge;

final class OccurrenceSubscriber implements EventSubscriberInterface {
    private array $current = [];
    public static function getSubscribedEvents(): array {
        return [EmailEvents::ON_CAMPAIGN_BATCH_ACTION=>['capture',1000],EmailEvents::EMAIL_ON_SEND=>['stamp',1000],MessageEvent::class=>['message',1000],SentMessageEvent::class=>['accepted',0],FailedMessageEvent::class=>['failed',0]];
    }
    public function capture(PendingEvent $event): void {
        if (!$event->checkContext('email.send')) return;
        $this->current=[];
        foreach ($event->getPending() as $log) {
            $value=['instance'=>'synthetic-a','event'=>$event->getEvent()->getId(),'lead'=>$log->getLead()->getId(),'rotation'=>$log->getRotation(),'log'=>$log->getId()];
            $value['intent']=hash('sha256',json_encode($value,JSON_THROW_ON_ERROR));
            Bridge::call('/capture',$value);
            $this->current[$value['event'].':'.$value['lead']][]=$value;
            $this->record(['kind'=>'native-log',...$value]);
        }
    }
    public function stamp(EmailSendEvent $event): void {
        $source=$event->getSource();
        if (($source[0]??null)!=='campaign.event') return;
        $lead=$event->getLead();$id=is_array($lead)?($lead['id']??null):$lead?->getId();
        $matches=$this->current[$source[1].':'.$id]??[];
        if (count($matches)!==1) throw new \RuntimeException('Missing or ambiguous native occurrence');
        $event->addTextHeader('X-Remold-Intent',$matches[0]['intent']);
        $this->record(['kind'=>'message-stamped',...$matches[0]]);
    }
    public function message(MessageEvent $event): void {
        $message=$event->getMessage();
        $header=method_exists($message,'getHeaders')?$message->getHeaders()->get('X-Remold-Intent'):null;
        if ($event->isQueued() && $header) {Bridge::probe('queued',$message->toString(),$header->getBodyAsString(),$event->getEnvelope());Bridge::call('/seal',Bridge::payload($message,$event->getEnvelope()));}
        $this->record(['kind'=>$event->isQueued()?'queue-observed':'transport-observed','intent'=>$header?->getBodyAsString(),'recipients'=>count($event->getEnvelope()->getRecipients())]);
    }
    public function accepted(SentMessageEvent $event): void {
        $message=$event->getMessage()->getOriginalMessage();
        $header=method_exists($message,'getHeaders')?$message->getHeaders()->get('X-Remold-Intent'):null;
        $this->record(['kind'=>'transport-accepted','intent'=>$header?->getBodyAsString()]);
    }
    public function failed(FailedMessageEvent $event): void {
        $message=$event->getMessage();
        $header=method_exists($message,'getHeaders')?$message->getHeaders()->get('X-Remold-Intent'):null;
        $this->record(['kind'=>'transport-unconfirmed','intent'=>$header?->getBodyAsString()]);
    }
    private function record(array $value): void {
        if (false===file_put_contents('/var/www/html/var/logs/remold-capture.jsonl',json_encode($value,JSON_THROW_ON_ERROR)."\n",FILE_APPEND|LOCK_EX)) throw new \RuntimeException('Occurrence capture failed');
    }
}
