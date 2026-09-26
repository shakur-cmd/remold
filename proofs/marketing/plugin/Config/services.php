<?php
use Symfony\Component\DependencyInjection\Loader\Configurator\ContainerConfigurator;
use MauticPlugin\RemoldGuardBundle\EventListener\OccurrenceSubscriber;
use MauticPlugin\RemoldGuardBundle\Transport\GuardTransportFactory;
return function(ContainerConfigurator $container): void {
    $container->services()->set(OccurrenceSubscriber::class)->autowire()->autoconfigure()->public();
    $container->services()->set(GuardTransportFactory::class)->autowire()->autoconfigure()->tag('mailer.transport_factory');
};
