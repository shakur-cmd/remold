<?php
declare(strict_types=1);
namespace MauticPlugin\RemoldGuardBundle\Transport;
use Symfony\Component\Mailer\Transport\AbstractTransportFactory;
use Symfony\Component\Mailer\Transport\Dsn;
use Symfony\Component\Mailer\Transport\TransportInterface;
final class GuardTransportFactory extends AbstractTransportFactory {
    protected function getSupportedSchemes(): array { return ['remold']; }
    public function create(Dsn $dsn): TransportInterface { return new GuardTransport($this->dispatcher,$this->logger); }
}
