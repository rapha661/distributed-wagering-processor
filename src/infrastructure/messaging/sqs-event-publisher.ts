import { GetQueueUrlCommand, SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher, PublishResult } from '../../application/ports';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';

const SQS_BATCH_LIMIT = 10;

/**
 * Publica os envelopes da outbox numa fila FIFO. O grupo é o aggregateId (ordem por agregado)
 * e a deduplicação do broker usa o eventId. Essa deduplicação é só otimização: o consumidor
 * ainda deve descartar eventIds repetidos.
 */
export class SqsEventPublisher implements EventPublisher {
  private queueUrl: string | undefined;

  constructor(
    private readonly sqs: SQSClient,
    private readonly queueName: string,
    private readonly timeoutMs: number,
  ) {}

  async publish(messages: readonly OutboxMessage[]): Promise<PublishResult> {
    const result: PublishResult = { published: [], failed: [] };
    let queueUrl: string;
    try {
      queueUrl = await this.resolveQueueUrl();
    } catch {
      result.failed.push(...messages.map((message) => message.id));
      return result;
    }

    for (let start = 0; start < messages.length; start += SQS_BATCH_LIMIT) {
      const chunk = messages.slice(start, start + SQS_BATCH_LIMIT);
      try {
        const response = await this.sqs.send(
          new SendMessageBatchCommand({
            QueueUrl: queueUrl,
            Entries: chunk.map((message, index) => ({
              Id: String(index),
              MessageBody: JSON.stringify(message.payload),
              MessageGroupId: message.aggregateId,
              MessageDeduplicationId: message.id,
              MessageAttributes: { eventType: { DataType: 'String', StringValue: message.eventType } },
            })),
          }),
          { abortSignal: AbortSignal.timeout(this.timeoutMs) },
        );
        const accepted = new Set((response.Successful ?? []).map((entry) => entry.Id));
        for (const [index, message] of chunk.entries()) {
          (accepted.has(String(index)) ? result.published : result.failed).push(message.id);
        }
      } catch {
        result.failed.push(...chunk.map((message) => message.id));
      }
    }
    return result;
  }

  private async resolveQueueUrl(): Promise<string> {
    if (!this.queueUrl) {
      const response = await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.queueName }), {
        abortSignal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.QueueUrl) {
        throw new Error(`queue ${this.queueName} not found`);
      }
      this.queueUrl = response.QueueUrl;
    }
    return this.queueUrl;
  }
}
