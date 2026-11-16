import { Global, Module } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { SQSClient } from '@aws-sdk/client-sqs';
import { APP_CONFIG, type AppConfig } from '../../config';
import { DatabaseAndQueueProbe } from './backlog-probe';
import { type AppLogger, createLogger, LOGGER, NestLogger } from './logging';
import { Metrics } from './metrics';

@Global()
@Module({
  providers: [
    {
      provide: LOGGER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createLogger(config.LOG_LEVEL),
    },
    {
      provide: NestLogger,
      inject: [LOGGER],
      useFactory: (logger: AppLogger) => new NestLogger(logger),
    },
    {
      provide: Metrics,
      inject: [MikroORM, SQSClient, APP_CONFIG],
      useFactory: (orm: MikroORM, sqs: SQSClient, config: AppConfig) =>
        new Metrics(new DatabaseAndQueueProbe(orm, sqs, config.SQS_WAGER_DLQ, config.SQS_REQUEST_TIMEOUT_MS)),
    },
  ],
  exports: [LOGGER, NestLogger, Metrics],
})
export class ObservabilityModule {}
