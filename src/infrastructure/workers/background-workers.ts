import { type BeforeApplicationShutdown, Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { PublishOutbox } from '../../application/publish-outbox';
import { ReprocessPendingReferences } from '../../application/reprocess-pending-references';
import { APP_CONFIG, type AppConfig } from '../../config';
import { WagerTransactionStatus } from '../../domain/wagering/wager-types';
import { SqsWagerConsumer } from '../messaging/sqs-wager-consumer';
import { type AppLogger, LOGGER } from '../observability/logging';
import { Metrics } from '../observability/metrics';
import { PollingLoop } from './polling-loop';

interface Worker {
  start(): void;
  stop(): Promise<void>;
}

/**
 * Workers em segundo plano da instância. Param antes do fechamento do banco
 * (beforeApplicationShutdown roda antes de onApplicationShutdown), então no SIGTERM o
 * consumidor ainda consegue concluir a mensagem em andamento.
 */
@Injectable()
export class BackgroundWorkers implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger: AppLogger;
  private readonly loops: Worker[];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PublishOutbox) private readonly publishOutbox: PublishOutbox,
    @Inject(ReprocessPendingReferences) private readonly reprocess: ReprocessPendingReferences,
    @Inject(SqsWagerConsumer) consumer: SqsWagerConsumer,
    @Inject(Metrics) private readonly metrics: Metrics,
    @Inject(LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ component: 'workers' });
    this.loops = [
      consumer,
      new PollingLoop('outbox-publisher', () => this.publishOutboxBatch(), config.OUTBOX_POLL_INTERVAL_MS, this.logger),
      new PollingLoop(
        'pending-reference-worker',
        () => this.reprocessPendingReferences(),
        config.PENDING_REFERENCE_POLL_INTERVAL_MS,
        this.logger,
      ),
    ];
  }

  onApplicationBootstrap(): void {
    if (this.config.APP_ROLE === 'api') {
      return;
    }
    for (const loop of this.loops) {
      loop.start();
    }
    this.logger.info({ workers: this.loops.length }, 'background workers started');
  }

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all(this.loops.map((loop) => loop.stop()));
  }

  private async publishOutboxBatch(): Promise<boolean> {
    const { published, failed } = await this.publishOutbox.publishBatch();
    if (failed > 0) {
      this.metrics.retries.inc({ operation: 'outbox_publish', reason: 'publish_failed' }, failed);
      this.logger.warn({ published, failed }, 'outbox publish failed, retry scheduled');
    }
    return published > 0;
  }

  private async reprocessPendingReferences(): Promise<boolean> {
    const results = await this.reprocess.processDue(this.config.PENDING_REFERENCE_BATCH_SIZE);
    for (const { transactionId, walletId, status } of results) {
      if (status === WagerTransactionStatus.PendingReference) {
        this.metrics.retries.inc({ operation: 'pending_reference', reason: 'reference_not_found' });
      } else {
        this.metrics.transactions.inc({ status, source: 'pending_reference' });
        this.logger.info({ transactionId, walletId, status }, 'pending transaction settled');
      }
    }
    return results.length > 0;
  }
}
