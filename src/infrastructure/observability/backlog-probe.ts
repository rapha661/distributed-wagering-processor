import { GetQueueAttributesCommand, GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { BacklogProbe } from './metrics';

export class DatabaseAndQueueProbe implements BacklogProbe {
  private deadLetterUrl: string | undefined;

  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
    private readonly deadLetterQueueName: string,
    private readonly timeoutMs: number,
  ) {}

  async outboxPending(): Promise<number> {
    return this.number('select count(*)::int as value from outbox_messages where published_at is null');
  }

  async outboxLagSeconds(): Promise<number> {
    // relógio do banco: o mesmo para todas as instâncias
    return this.number(
      `select coalesce(extract(epoch from now() - min(occurred_at)), 0)::float8 as value
         from outbox_messages where published_at is null`,
    );
  }

  async pendingReferences(): Promise<number> {
    return this.number(`select count(*)::int as value from wager_transactions where status = 'PENDING_REFERENCE'`);
  }

  async deadLetterMessages(): Promise<number> {
    const abortSignal = AbortSignal.timeout(this.timeoutMs);
    if (!this.deadLetterUrl) {
      const { QueueUrl } = await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.deadLetterQueueName }), { abortSignal });
      this.deadLetterUrl = QueueUrl;
    }
    const { Attributes } = await this.sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: this.deadLetterUrl, AttributeNames: ['ApproximateNumberOfMessages'] }),
      { abortSignal },
    );
    return Number(Attributes?.ApproximateNumberOfMessages ?? Number.NaN);
  }

  private async number(query: string): Promise<number> {
    const [row] = await this.orm.em.getConnection().execute<{ value: number }[]>(query);
    return Number(row?.value ?? Number.NaN);
  }
}
