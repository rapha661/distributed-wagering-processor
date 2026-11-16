import { Logger, Module } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { SQSClient } from '@aws-sdk/client-sqs';
import { CreateWallet } from './application/create-wallet';
import { ProcessWagerTransaction } from './application/process-wager-transaction';
import type { UnitOfWork } from './application/ports';
import { PublishOutbox } from './application/publish-outbox';
import { ReprocessPendingReferences } from './application/reprocess-pending-references';
import { WalletQueries } from './application/wallet-queries';
import { APP_CONFIG, type AppConfig } from './config';
import { BackoffPolicy } from './domain/shared/backoff-policy';
import { WageringController } from './http/wagering.controller';
import { WalletsController } from './http/wallets.controller';
import { SqsEventPublisher } from './infrastructure/messaging/sqs-event-publisher';
import { SqsWagerConsumer } from './infrastructure/messaging/sqs-wager-consumer';
import { MikroOrmWageringQueries } from './infrastructure/persistence/mikro-orm-queries';
import { MikroOrmUnitOfWork } from './infrastructure/persistence/mikro-orm-unit-of-work';
import { systemClock, uuidV7Generator } from './infrastructure/system';
import { BackgroundWorkers } from './infrastructure/workers/background-workers';

export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');
export const REFERENCE_RETRY_POLICY = Symbol('REFERENCE_RETRY_POLICY');

@Module({
  controllers: [WalletsController, WageringController],
  providers: [
    {
      provide: UNIT_OF_WORK,
      inject: [MikroORM, APP_CONFIG],
      useFactory: (orm: MikroORM, config: AppConfig) => new MikroOrmUnitOfWork(orm, config.DATABASE_LOCK_TIMEOUT_MS),
    },
    {
      provide: REFERENCE_RETRY_POLICY,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new BackoffPolicy(config.REFERENCE_RETRY_BASE_MS, config.REFERENCE_RETRY_MAX_MS, config.REFERENCE_RETRY_MAX_ATTEMPTS),
    },
    {
      provide: ProcessWagerTransaction,
      inject: [UNIT_OF_WORK, REFERENCE_RETRY_POLICY],
      useFactory: (uow: UnitOfWork, retry: BackoffPolicy) =>
        new ProcessWagerTransaction(uow, systemClock, uuidV7Generator, retry),
    },
    {
      provide: CreateWallet,
      inject: [UNIT_OF_WORK],
      useFactory: (uow: UnitOfWork) => new CreateWallet(uow, systemClock, uuidV7Generator),
    },
    {
      provide: PublishOutbox,
      inject: [UNIT_OF_WORK, SQSClient, APP_CONFIG],
      useFactory: (uow: UnitOfWork, sqs: SQSClient, config: AppConfig) =>
        new PublishOutbox(
          uow,
          new SqsEventPublisher(sqs, config.SQS_EVENTS_QUEUE, config.SQS_REQUEST_TIMEOUT_MS),
          systemClock,
          config.OUTBOX_BATCH_SIZE,
        ),
    },
    {
      provide: ReprocessPendingReferences,
      inject: [UNIT_OF_WORK, REFERENCE_RETRY_POLICY],
      useFactory: (uow: UnitOfWork, retry: BackoffPolicy) =>
        new ReprocessPendingReferences(uow, systemClock, uuidV7Generator, retry),
    },
    {
      provide: SqsWagerConsumer,
      inject: [SQSClient, ProcessWagerTransaction, APP_CONFIG],
      useFactory: (sqs: SQSClient, processWager: ProcessWagerTransaction, config: AppConfig) =>
        new SqsWagerConsumer(
          sqs,
          processWager,
          systemClock,
          {
            queueName: config.SQS_WAGER_QUEUE,
            deadLetterQueueName: config.SQS_WAGER_DLQ,
            retry: new BackoffPolicy(
              config.SQS_CONSUMER_RETRY_BASE_MS,
              config.SQS_CONSUMER_RETRY_MAX_MS,
              config.SQS_CONSUMER_MAX_ATTEMPTS,
            ),
            batchSize: config.SQS_CONSUMER_BATCH_SIZE,
            waitTimeSeconds: config.SQS_CONSUMER_WAIT_SECONDS,
            requestTimeoutMs: config.SQS_REQUEST_TIMEOUT_MS,
          },
          new Logger('WagerConsumer'),
        ),
    },
    BackgroundWorkers,
    {
      provide: WalletQueries,
      inject: [MikroORM],
      useFactory: (orm: MikroORM) => {
        const logger = new Logger('Reconciliation');
        return new WalletQueries(new MikroOrmWageringQueries(orm), {
          mismatch: (report) => logger.error(`wallet ${report.walletId} diverges from ledger by ${report.difference}`),
        });
      },
    },
  ],
  exports: [ProcessWagerTransaction, UNIT_OF_WORK, REFERENCE_RETRY_POLICY],
})
export class WageringModule {}
