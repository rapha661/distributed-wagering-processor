import { createHash } from 'node:crypto';
import {
  ChangeMessageVisibilityBatchCommand,
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { z } from 'zod';
import { ApplicationError, TransientFailureError } from '../../application/errors';
import type { ProcessWagerTransaction, SubmitWagerCommand } from '../../application/process-wager-transaction';
import type { Clock } from '../../application/ports';
import type { ReceiveInboxProps } from '../../domain/messaging/inbox-message';
import type { BackoffPolicy } from '../../domain/shared/backoff-policy';
import { canonicalJson } from '../../domain/shared/canonical-json';
import { DomainError } from '../../domain/shared/errors';
import { idempotencyKeyHeader, parse, RequestValidationError, submitWagerBody } from '../../http/request-schemas';

export const WAGER_CONSUMER_NAME = 'wager-transactions-consumer';

const wagerMessage = z.object({
  messageId: z.string().min(1).max(255),
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.iso.datetime(),
  data: submitWagerBody.extend({ idempotencyKey: idempotencyKeyHeader }),
});

export interface WagerConsumerOptions {
  queueName: string;
  deadLetterQueueName: string;
  /** Visibilidade entre tentativas; `maxAttempts` é o limite antes da DLQ. */
  retry: BackoffPolicy;
  batchSize: number;
  waitTimeSeconds: number;
  requestTimeoutMs: number;
}

export interface ConsumerLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

interface Decoded {
  command: SubmitWagerCommand;
  delivery: ReceiveInboxProps;
}

/**
 * Consumidor de `wager-transactions.fifo`, com o mesmo caso de uso da API. O inbox
 * (consumerName, messageId) é gravado na mesma transação do resultado e o ack (delete) só
 * acontece depois do commit: se o processo morrer entre os dois, a redelivery cai no replay.
 *
 * - resultado de negócio (processada, pendente ou rejeitada): ack;
 * - erro permanente (mensagem inválida, conflito, wallet inexistente): DLQ na hora;
 * - erro transitório ou inesperado: volta para a fila com backoff de visibilidade. Esgotadas
 *   as tentativas, a transação é gravada como FAILED e a mensagem vai para a DLQ.
 *
 * As mensagens de um lote são tratadas uma a uma, sem segurar o resto do grupo quando uma
 * falha: a ordem não é garantia de consistência (o domínio aceita referência fora de ordem).
 * O redrive da fila continua como rede de segurança para mensagens que derrubam o processo.
 */
export class SqsWagerConsumer {
  private stopping = new AbortController();
  private loop: Promise<void> | undefined;
  private readonly queueUrls = new Map<string, string>();

  constructor(
    private readonly sqs: SQSClient,
    private readonly processWager: ProcessWagerTransaction,
    private readonly clock: Clock,
    private readonly options: WagerConsumerOptions,
    private readonly logger: ConsumerLogger,
  ) {}

  start(): void {
    if (this.loop) {
      return;
    }
    this.stopping = new AbortController();
    this.loop = this.run();
  }

  /** Para de receber, conclui a mensagem em andamento e devolve a visibilidade das demais. */
  async stop(): Promise<void> {
    this.stopping.abort();
    await this.loop;
    this.loop = undefined;
  }

  /** Recebe um lote (long polling) e trata cada mensagem. Devolve quantas recebeu. */
  async poll(): Promise<number> {
    const queueUrl = await this.queueUrl(this.options.queueName);
    let messages: Message[];
    try {
      const response = await this.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: this.options.batchSize,
          WaitTimeSeconds: this.options.waitTimeSeconds,
          MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
          MessageAttributeNames: ['correlationId'],
        }),
        {
          abortSignal: AbortSignal.any([
            this.stopping.signal,
            AbortSignal.timeout(this.options.waitTimeSeconds * 1_000 + this.options.requestTimeoutMs),
          ]),
        },
      );
      messages = response.Messages ?? [];
    } catch (error) {
      if (this.stopping.signal.aborted) {
        return 0;
      }
      throw error;
    }

    for (const [index, message] of messages.entries()) {
      if (this.stopping.signal.aborted) {
        await this.release(queueUrl, messages.slice(index));
        break;
      }
      try {
        await this.handle(queueUrl, message);
      } catch (error) {
        // sem ack: a mensagem volta quando o visibility timeout vencer
        this.logger.error(`message ${message.MessageId} not handled: ${describe(error)}`);
      }
    }
    return messages.length;
  }

  private async run(): Promise<void> {
    while (!this.stopping.signal.aborted) {
      try {
        await this.poll();
      } catch (error) {
        this.logger.error(`wager consumer failed: ${describe(error)}`);
        await pause(1_000, this.stopping.signal);
      }
    }
  }

  private async handle(queueUrl: string, message: Message): Promise<void> {
    const attempt = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
    let decoded: Decoded;
    try {
      decoded = this.decode(message);
    } catch (error) {
      return this.deadLetter(queueUrl, message, error, attempt);
    }

    try {
      const result = await this.processWager.execute(decoded.command, decoded.delivery);
      this.logger.log(`message ${decoded.delivery.messageId}: ${result.status}${result.idempotentReplay ? ' (replay)' : ''}`);
    } catch (error) {
      if (isPermanent(error)) {
        return this.deadLetter(queueUrl, message, error, attempt);
      }
      if (this.options.retry.isExhausted(attempt)) {
        return this.giveUp(queueUrl, message, decoded.command, error, attempt);
      }
      return this.retryLater(queueUrl, message, error, attempt);
    }
    await this.ack(queueUrl, message);
  }

  private decode(message: Message): Decoded {
    let body: unknown;
    try {
      body = JSON.parse(message.Body ?? '');
    } catch {
      throw new RequestValidationError('INVALID_MESSAGE', [{ path: '(root)', message: 'body is not valid JSON' }]);
    }
    const { messageId, data } = parse(wagerMessage, body, 'INVALID_MESSAGE');
    const { idempotencyKey, ...request } = data;
    return {
      command: {
        idempotencyKey,
        request,
        correlationId: message.MessageAttributes?.correlationId?.StringValue ?? messageId,
        causationId: messageId,
      },
      delivery: {
        consumerName: WAGER_CONSUMER_NAME,
        messageId,
        payloadHash: createHash('sha256').update(canonicalJson(data)).digest('hex'),
        receivedAt: this.clock.now(),
      },
    };
  }

  private async ack(queueUrl: string, message: Message): Promise<void> {
    try {
      await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }), {
        abortSignal: AbortSignal.timeout(this.options.requestTimeoutMs),
      });
    } catch (error) {
      // o efeito já foi commitado; a redelivery vai cair no inbox
      this.logger.warn(`ack of message ${message.MessageId} failed: ${describe(error)}`);
    }
  }

  private async retryLater(queueUrl: string, message: Message, error: unknown, attempt: number): Promise<void> {
    const delaySeconds = Math.ceil(this.options.retry.delayMs(attempt) / 1_000);
    this.logger.warn(`message ${message.MessageId} failed (attempt ${attempt}), retry in ${delaySeconds}s: ${describe(error)}`);
    try {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: delaySeconds }),
        { abortSignal: AbortSignal.timeout(this.options.requestTimeoutMs) },
      );
    } catch {
      // sem o backoff, a mensagem volta quando o visibility timeout da fila vencer
    }
  }

  /** Tentativas esgotadas: grava FAILED (se ainda não houver resultado) e manda para a DLQ. */
  private async giveUp(
    queueUrl: string,
    message: Message,
    command: SubmitWagerCommand,
    error: unknown,
    attempt: number,
  ): Promise<void> {
    try {
      const result = await this.processWager.recordFailure(command);
      if (result.idempotentReplay) {
        // outra entrega já resolveu a transação
        return this.ack(queueUrl, message);
      }
    } catch (recordError) {
      this.logger.warn(`could not record FAILED for message ${message.MessageId}: ${describe(recordError)}`);
    }
    return this.deadLetter(queueUrl, message, error, attempt);
  }

  private async deadLetter(queueUrl: string, message: Message, error: unknown, attempt: number): Promise<void> {
    const deadLetterUrl = await this.queueUrl(this.options.deadLetterQueueName);
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: deadLetterUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: {
          errorCode: { DataType: 'String', StringValue: codeOf(error) },
          errorMessage: { DataType: 'String', StringValue: describe(error).slice(0, 1_000) },
          attempts: { DataType: 'Number', StringValue: String(attempt) },
        },
      }),
      { abortSignal: AbortSignal.timeout(this.options.requestTimeoutMs) },
    );
    await this.ack(queueUrl, message);
    this.logger.warn(`message ${message.MessageId} moved to ${this.options.deadLetterQueueName}: ${codeOf(error)}`);
  }

  private async release(queueUrl: string, messages: Message[]): Promise<void> {
    try {
      await this.sqs.send(
        new ChangeMessageVisibilityBatchCommand({
          QueueUrl: queueUrl,
          Entries: messages.map((message, index) => ({
            Id: String(index),
            ReceiptHandle: message.ReceiptHandle,
            VisibilityTimeout: 0,
          })),
        }),
        { abortSignal: AbortSignal.timeout(this.options.requestTimeoutMs) },
      );
    } catch (error) {
      this.logger.warn(`could not release ${messages.length} messages: ${describe(error)}`);
    }
  }

  private async queueUrl(name: string): Promise<string> {
    let url = this.queueUrls.get(name);
    if (!url) {
      const response = await this.sqs.send(new GetQueueUrlCommand({ QueueName: name }), {
        abortSignal: AbortSignal.timeout(this.options.requestTimeoutMs),
      });
      if (!response.QueueUrl) {
        throw new Error(`queue ${name} not found`);
      }
      url = response.QueueUrl;
      this.queueUrls.set(name, url);
    }
    return url;
  }
}

/** Erros que se repetiriam em qualquer nova tentativa. */
function isPermanent(error: unknown): boolean {
  if (error instanceof TransientFailureError) {
    return false;
  }
  return error instanceof ApplicationError || error instanceof DomainError || error instanceof RequestValidationError;
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'UNEXPECTED_ERROR';
}

function describe(error: unknown): string {
  if (error instanceof RequestValidationError) {
    return `${error.message}: ${error.details.map((detail) => `${detail.path} ${detail.message}`).join('; ')}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}
