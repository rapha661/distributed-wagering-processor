import type { IntegrationEvent } from '../events/integration-event';
import { BackoffPolicy } from '../shared/backoff-policy';
import { InvalidStateError } from '../shared/errors';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | undefined;
  publishedAt: Date | undefined;
}

/** Evento aguardando publicação. É gravado na mesma transação SQL da mudança que o gerou. */
export class OutboxMessage {
  /** Sem limite de tentativas: um evento confirmado nunca é descartado. */
  static readonly retryPolicy = new BackoffPolicy(1_000, 60_000);

  private constructor(
    readonly id: string,
    readonly aggregateId: string,
    readonly eventType: string,
    readonly payload: Readonly<Record<string, unknown>>,
    readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
    private _publishedAt: Date | undefined,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.toJSON(),
      event.occurredAt,
      0,
      event.occurredAt,
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    const dueAt = this._nextAttemptAt ?? this.occurredAt;
    return this.isPending() && dueAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    this.assertPending();
    this._publishedAt = at;
  }

  /** Incrementa as tentativas e agenda a próxima com backoff exponencial. */
  scheduleRetry(now: Date, policy: BackoffPolicy = OutboxMessage.retryPolicy): void {
    this.assertPending();
    this._attempts += 1;
    this._nextAttemptAt = policy.nextAttemptAt(now, this._attempts);
  }

  private assertPending(): void {
    if (!this.isPending()) {
      throw new InvalidStateError(`outbox message ${this.id} was already published`);
    }
  }
}
