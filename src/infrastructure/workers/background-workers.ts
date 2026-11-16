import { type BeforeApplicationShutdown, Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { PublishOutbox } from '../../application/publish-outbox';
import { ReprocessPendingReferences } from '../../application/reprocess-pending-references';
import { APP_CONFIG, type AppConfig } from '../../config';
import { PollingLoop } from './polling-loop';

/**
 * Workers em segundo plano da instância. Param antes do fechamento do banco
 * (beforeApplicationShutdown roda antes de onApplicationShutdown).
 */
@Injectable()
export class BackgroundWorkers implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('Workers');
  private readonly loops: PollingLoop[];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PublishOutbox) publishOutbox: PublishOutbox,
    @Inject(ReprocessPendingReferences) reprocess: ReprocessPendingReferences,
  ) {
    this.loops = [
      new PollingLoop(
        'outbox-publisher',
        async () => (await publishOutbox.publishBatch()).published > 0,
        config.OUTBOX_POLL_INTERVAL_MS,
        this.logger,
      ),
      new PollingLoop(
        'pending-reference-worker',
        async () => (await reprocess.processDue(config.PENDING_REFERENCE_BATCH_SIZE)).length > 0,
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
    this.logger.log(`started ${this.loops.length} workers`);
  }

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all(this.loops.map((loop) => loop.stop()));
  }
}
