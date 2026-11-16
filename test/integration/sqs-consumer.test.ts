import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import {
  ChangeMessageVisibilityBatchCommand,
  DeleteMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { TransientFailureError } from '../../src/application/errors';
import type { UnitOfWork } from '../../src/application/ports';
import type { ProcessWagerTransaction, SubmitWagerCommand } from '../../src/application/process-wager-transaction';
import { BackoffPolicy } from '../../src/domain/shared/backoff-policy';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-types';
import {
  SqsWagerConsumer,
  WAGER_CONSUMER_NAME,
  type WagerConsumerOptions,
} from '../../src/infrastructure/messaging/sqs-wager-consumer';
import { createLogger } from '../../src/infrastructure/observability/logging';
import { Metrics } from '../../src/infrastructure/observability/metrics';
import { systemClock } from '../../src/infrastructure/system';
import {
  bet,
  createTestContext,
  expectConsistent,
  holdWalletLock,
  openWallet,
  sql,
  type TestContext,
  wager,
} from './support/context';
import { createConsumerQueues, drainQueue, queueDepth, testSqsClient, type TestQueue } from './support/sqs';

let ctx: TestContext;
let sqs: SQSClient;
let source: TestQueue;
let deadLetter: TestQueue;
const touched = new Set<string>();
const cleanup: (() => Promise<void>)[] = [];
const silent = createLogger('silent');

beforeAll(async () => {
  ctx = await createTestContext();
  sqs = testSqsClient();
});

afterEach(async () => {
  for (const release of cleanup.splice(0).reverse()) {
    await release();
  }
  for (const walletId of touched) {
    await expectConsistent(ctx, walletId);
  }
  touched.clear();
});

afterAll(async () => {
  await ctx.close();
  sqs.destroy();
});

async function queues(options: { visibilityTimeoutSeconds?: number } = {}) {
  ({ source, deadLetter } = await createConsumerQueues(sqs, options));
  cleanup.push(() => source.remove(), () => deadLetter.remove());
}

async function wallet(amount = '100.00') {
  const created = await openWallet(ctx, amount);
  touched.add(created.id);
  return created;
}

function envelope(command: SubmitWagerCommand, messageId = `msg-${crypto.randomUUID()}`) {
  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: { ...command.request, idempotencyKey: command.idempotencyKey },
  };
}

async function send(body: unknown, group = 'group-1') {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: source.url,
      MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
      MessageGroupId: group,
      // id de deduplicação novo a cada envio: o broker não descarta reenvios
      MessageDeduplicationId: crypto.randomUUID(),
    }),
  );
}

function consumer(
  options: Partial<WagerConsumerOptions> & { process?: ProcessWagerTransaction; client?: SQSClient } = {},
) {
  const { process, client, ...overrides } = options;
  return new SqsWagerConsumer(
    client ?? sqs,
    process ?? ctx.process,
    systemClock,
    {
      queueName: source.name,
      deadLetterQueueName: deadLetter.name,
      retry: new BackoffPolicy(1_000, 1_000, 3),
      batchSize: 10,
      waitTimeSeconds: 0,
      requestTimeoutMs: 5_000,
      ...overrides,
    },
    silent,
    new Metrics(),
  );
}

async function pollUntil(subject: SqsWagerConsumer, done: () => Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > deadline) {
      throw new Error('consumer did not reach the expected state in time');
    }
    if ((await subject.poll()) === 0) {
      await Bun.sleep(100);
    }
  }
}

const emptyQueue = async (queue: TestQueue) => {
  const depth = await queueDepth(sqs, queue.url);
  return depth.visible === 0 && depth.inFlight === 0;
};

const transactionsOf = (idempotencyKey: string) =>
  sql<{ status: string; failure_code: string | null }>(
    ctx,
    'select status, failure_code from wager_transactions where idempotency_key = ?',
    [idempotencyKey],
  );

const inboxOf = (messageId: string) =>
  sql<{ processed_at: string | null }>(
    ctx,
    'select processed_at from inbox_messages where consumer_name = ? and message_id = ?',
    [WAGER_CONSUMER_NAME, messageId],
  );

const eventsCausedBy = (messageId: string) =>
  sql(ctx, `select 1 from outbox_messages where payload->>'causationId' = ?`, [messageId]);

const ledgerSize = async (walletId: string) =>
  (await sql<{ n: number }>(ctx, 'select count(*)::int as n from wallet_ledger_entries where wallet_id = ?', [walletId]))[0]?.n;

const balanceOf = async (walletId: string) => (await ctx.queries.getWallet(walletId)).balance.amount;

describe('consumidor da fila de transações', () => {
  it('processa com o mesmo caso de uso da API, grava o inbox e só então faz ack', async () => {
    await queues();
    const w = await wallet('100.00');
    const command = bet(w, '25.00');
    const message = envelope(command);
    await send(message, w.id);

    expect(await consumer().poll()).toBe(1);

    expect(await balanceOf(w.id)).toBe('75.00');
    expect(await transactionsOf(command.idempotencyKey)).toMatchObject([{ status: 'PROCESSED' }]);
    expect(await inboxOf(message.messageId)).toMatchObject([{ processed_at: expect.any(String) }]);
    expect(await eventsCausedBy(message.messageId)).toHaveLength(2);
    expect(await emptyQueue(source)).toBe(true);
    expect(await emptyQueue(deadLetter)).toBe(true);
  });

  it('rejeição de negócio é terminal: grava REJECTED e faz ack', async () => {
    await queues();
    const w = await wallet('100.00');
    const command = bet(w, '500.00');
    await send(envelope(command), w.id);

    await consumer().poll();

    expect(await transactionsOf(command.idempotencyKey)).toMatchObject([
      { status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' },
    ]);
    expect(await balanceOf(w.id)).toBe('100.00');
    expect(await emptyQueue(source)).toBe(true);
    expect(await emptyQueue(deadLetter)).toBe(true);
  });
});

describe('redelivery', () => {
  it('ack perdido depois do commit: a redelivery cai no inbox e não duplica o efeito', async () => {
    await queues({ visibilityTimeoutSeconds: 1 });
    const w = await wallet('100.00');
    const command = bet(w, '25.00');
    const message = envelope(command);
    await send(message, w.id);

    let lostAcks = 1;
    const flaky = {
      send: (request: unknown, options?: unknown) =>
        request instanceof DeleteMessageCommand && lostAcks-- > 0
          ? Promise.reject(new Error('conexão caiu antes do ack'))
          : sqs.send(request as never, options as never),
    } as unknown as SQSClient;
    const subject = consumer({ client: flaky });

    await subject.poll();
    expect(await balanceOf(w.id)).toBe('75.00');
    expect((await queueDepth(sqs, source.url)).inFlight).toBe(1);

    await pollUntil(subject, () => emptyQueue(source));

    expect(await balanceOf(w.id)).toBe('75.00');
    expect(await transactionsOf(command.idempotencyKey)).toHaveLength(1);
    expect(await ledgerSize(w.id)).toBe(2);
    expect(await inboxOf(message.messageId)).toHaveLength(1);
    expect(await eventsCausedBy(message.messageId)).toHaveLength(2);
  });

  it('a mesma mensagem enviada duas vezes é consumida uma vez só', async () => {
    await queues();
    const w = await wallet('100.00');
    const command = bet(w, '25.00');
    const message = envelope(command);
    await send(message, w.id);
    await send(message, w.id);

    await pollUntil(consumer(), () => emptyQueue(source));

    expect(await balanceOf(w.id)).toBe('75.00');
    expect(await transactionsOf(command.idempotencyKey)).toHaveLength(1);
    expect(await inboxOf(message.messageId)).toHaveLength(1);
    expect(await emptyQueue(deadLetter)).toBe(true);
  });

  it('mesmo messageId com outro conteúdo vai para a DLQ, sem efeito', async () => {
    await queues();
    const w = await wallet('100.00');
    const first = envelope(bet(w, '25.00'));
    await send(first, w.id);
    await consumer().poll();

    await send(envelope(bet(w, '30.00'), first.messageId), w.id);
    await consumer().poll();

    const [dead] = await drainQueue(sqs, deadLetter.url, 1);
    expect(dead?.attributes.errorCode).toBe('MESSAGE_ID_REUSED');
    expect(dead?.body.data.money.amount).toBe('30.00');
    expect(await balanceOf(w.id)).toBe('75.00');
  });
});

describe('erros permanentes e transitórios', () => {
  it('mensagem que nunca vai passar vai direto para a DLQ, sem nova tentativa', async () => {
    await queues();
    const w = await wallet('100.00');
    const commands = {
      wrongType: bet(w, '10.00'),
      invalidMoney: bet(w, '10.001'),
      missingReference: wager(w, WagerTransactionKind.Refund, '10.00'),
      unknownWallet: bet({ id: crypto.randomUUID(), playerId: w.playerId }, '10.00'),
    };
    await send('isto não é json');
    await send({ ...envelope(commands.wrongType), type: 'SomethingElse' });
    await send(envelope(commands.invalidMoney));
    await send(envelope(commands.missingReference));
    await send(envelope(commands.unknownWallet));

    await pollUntil(consumer(), () => emptyQueue(source));

    const dead = await drainQueue(sqs, deadLetter.url, 5);
    expect(dead.map((message) => message.attributes.errorCode)).toEqual([
      'INVALID_MESSAGE',
      'INVALID_MESSAGE',
      'INVALID_MONEY',
      'MISSING_REFERENCE',
      'WALLET_NOT_FOUND',
    ]);
    expect(dead.every((message) => message.attributes.attempts === '1')).toBe(true);
    for (const command of Object.values(commands)) {
      expect(await transactionsOf(command.idempotencyKey)).toHaveLength(0);
    }
    expect(await balanceOf(w.id)).toBe('100.00');
  });

  it('falha transitória volta para a fila com backoff e passa na tentativa seguinte', async () => {
    await queues();
    const quick = await createTestContext({ lockTimeoutMs: 200 });
    cleanup.push(() => quick.close());
    const w = await wallet('100.00');
    const command = bet(w, '25.00');
    await send(envelope(command), w.id);
    const subject = consumer({ process: quick.process });

    const lock = await holdWalletLock(ctx, w.id);
    try {
      await subject.poll();
    } finally {
      await lock.release();
    }
    expect(await transactionsOf(command.idempotencyKey)).toHaveLength(0);
    // continua na fila, invisível durante o backoff
    expect(await queueDepth(sqs, source.url)).toEqual({ visible: 0, inFlight: 1 });

    await pollUntil(subject, async () => (await transactionsOf(command.idempotencyKey)).length > 0);

    expect(await transactionsOf(command.idempotencyKey)).toMatchObject([{ status: 'PROCESSED' }]);
    expect(await balanceOf(w.id)).toBe('75.00');
    expect(await emptyQueue(source)).toBe(true);
    expect(await emptyQueue(deadLetter)).toBe(true);
  });

  it('falha transitória que não passa esgota as tentativas: grava FAILED e manda para a DLQ', async () => {
    await queues();
    let failures = 3;
    const unavailable = await createTestContext({
      uow: (base): UnitOfWork => ({
        run: (work) =>
          failures-- > 0
            ? Promise.reject(new TransientFailureError('DEPENDENCY_UNAVAILABLE', 'database unavailable'))
            : base.run(work),
      }),
    });
    cleanup.push(() => unavailable.close());
    const w = await wallet('100.00');
    const command = bet(w, '25.00');
    await send(envelope(command), w.id);

    await pollUntil(consumer({ process: unavailable.process }), async () => !(await emptyQueue(deadLetter)));

    const [dead] = await drainQueue(sqs, deadLetter.url, 1);
    expect(dead?.attributes).toMatchObject({ errorCode: 'DEPENDENCY_UNAVAILABLE', attempts: '3' });
    expect(await transactionsOf(command.idempotencyKey)).toMatchObject([
      { status: 'FAILED', failure_code: 'PROCESSING_FAILED' },
    ]);
    expect(await balanceOf(w.id)).toBe('100.00');
    expect(await ledgerSize(w.id)).toBe(1);
    expect(await emptyQueue(source)).toBe(true);
  });
});

describe('shutdown', () => {
  it('conclui a mensagem em andamento e devolve a visibilidade das que não começou', async () => {
    await queues();
    const wallets = [await wallet(), await wallet(), await wallet()];
    const commands = wallets.map((w) => bet(w, '10.00'));
    for (const [index, command] of commands.entries()) {
      await send(envelope(command), wallets[index]?.id);
    }

    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => (started = resolve));
    const slow = await createTestContext({
      uow: (base): UnitOfWork => ({
        run: async (work) => {
          started();
          await Bun.sleep(300);
          return base.run(work);
        },
      }),
    });
    cleanup.push(() => slow.close());
    const released: number[] = [];
    const spy = {
      send: (request: unknown, options?: unknown) => {
        if (request instanceof ChangeMessageVisibilityBatchCommand) {
          released.push(...(request.input.Entries ?? []).map((entry) => entry.VisibilityTimeout ?? -1));
        }
        return sqs.send(request as never, options as never);
      },
    } as unknown as SQSClient;
    const subject = consumer({ process: slow.process, client: spy, waitTimeSeconds: 1 });

    subject.start();
    await firstStarted;
    await subject.stop();

    const results = await Promise.all(commands.map((command) => transactionsOf(command.idempotencyKey)));
    expect(results.flat()).toMatchObject([{ status: 'PROCESSED' }]);
    expect(released).toEqual([0, 0]);
    expect(await queueDepth(sqs, source.url)).toEqual({ visible: 2, inFlight: 0 });
  });

  it('parar durante o long polling devolve o que chegar na espera, sem processar', async () => {
    await queues();
    const w = await wallet('100.00');
    const command = bet(w, '10.00');
    const subject = consumer({ waitTimeSeconds: 2 });
    subject.start();
    await Bun.sleep(300);

    const startedAt = Date.now();
    const stopped = subject.stop();
    await send(envelope(command), w.id);
    await stopped;

    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(await transactionsOf(command.idempotencyKey)).toHaveLength(0);
    expect(await queueDepth(sqs, source.url)).toEqual({ visible: 1, inFlight: 0 });
  });
});
