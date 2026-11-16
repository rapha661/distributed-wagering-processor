import type { Clock, EventPublisher, UnitOfWork } from './ports';

export interface PublishBatchResult {
  claimed: number;
  published: number;
  failed: number;
}

/**
 * Publica um lote da outbox. As linhas ficam travadas (SKIP LOCKED) só durante a publicação,
 * e o estado de cada uma (publicada ou nova tentativa) é gravado no mesmo commit.
 *
 * Se o processo morrer depois de publicar e antes do commit, as linhas voltam a ficar pendentes
 * e são publicadas de novo: a entrega é at-least-once, e o `eventId` estável permite ao
 * consumidor descartar a duplicata.
 */
export class PublishOutbox {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly batchSize: number,
  ) {}

  publishBatch(): Promise<PublishBatchResult> {
    return this.uow.run(async ({ outbox }) => {
      const messages = await outbox.claimDue(this.clock.now(), this.batchSize);
      if (messages.length === 0) {
        return { claimed: 0, published: 0, failed: 0 };
      }

      const result = await this.publisher.publish(messages);
      const published = new Set(result.published);
      const now = this.clock.now();
      for (const message of messages) {
        if (published.has(message.id)) {
          message.markPublished(now);
        } else {
          message.scheduleRetry(now);
        }
        outbox.update(message);
      }
      return { claimed: messages.length, published: published.size, failed: messages.length - published.size };
    });
  }
}
