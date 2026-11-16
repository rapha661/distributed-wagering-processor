import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher } from '../../src/application/ports';
import { PublishOutbox } from '../../src/application/publish-outbox';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { TestClock } from './support/clock';
import { bet, createTestContext, openWallet, sql, type TestContext } from './support/context';
import { createTestQueue, drainQueue, type TestQueue, testSqsClient } from './support/sqs';

let ctx: TestContext;
let sqs: SQSClient;
let queue: TestQueue;

const publisherFor = (client: SQSClient = sqs) => new SqsEventPublisher(client, queue.name, 2_000);
const pendingIds = async () =>
  (await sql<{ id: string }>(ctx, 'select id from outbox_messages where published_at is null order by occurred_at, id')).map((r) => r.id);

/** Gera eventos novos: abertura (2) + uma aposta (2). */
async function produceEvents(): Promise<string[]> {
  const wallet = await openWallet(ctx, '100.00');
  await ctx.process.execute(bet(wallet, '10.00'));
  return pendingIds();
}

beforeAll(async () => {
  ctx = await createTestContext();
  sqs = testSqsClient();
  queue = await createTestQueue(sqs, 'test-events');
});

beforeEach(async () => {
  // começa com a outbox limpa: outros testes deixam eventos pendentes no banco de teste
  await sql(ctx, 'update outbox_messages set published_at = now() where published_at is null');
});

afterAll(async () => {
  await queue.remove();
  sqs.destroy();
  await ctx.close();
});

describe('PublishOutbox', () => {
  it('publica os eventos pendentes depois do commit e marca como publicados', async () => {
    const ids = await produceEvents();
    expect(ids).toHaveLength(4);

    const result = await new PublishOutbox(ctx.uow, publisherFor(), new TestClock(), 50).publishBatch();
    expect(result).toEqual({ claimed: 4, published: 4, failed: 0 });
    expect(await pendingIds()).toEqual([]);

    const received = await drainQueue(sqs, queue.url, 4);
    expect(received.map((m) => m.body.eventId).sort()).toEqual([...ids].sort());
    const balanceChanged = received.find((m) => m.body.eventType === 'WalletBalanceChanged' && m.body.data.direction === 'DEBIT');
    expect(balanceChanged?.body).toMatchObject({
      version: 1,
      data: { money: { amount: '10.00', currency: 'BRL' }, balanceAfter: { amount: '90.00', currency: 'BRL' } },
    });
    expect(balanceChanged?.attributes.eventType).toBe('WalletBalanceChanged');
  });

  it('com o SQS fora do ar nada se perde: reagenda com backoff e publica depois', async () => {
    const ids = await produceEvents();
    const clock = new TestClock();
    const offline = testSqsClient('http://127.0.0.1:1');

    const failed = await new PublishOutbox(ctx.uow, publisherFor(offline), clock, 50).publishBatch();
    offline.destroy();
    expect(failed).toEqual({ claimed: 4, published: 0, failed: 4 });

    const [state] = await sql<{ attempts: number; due_later: boolean }>(
      ctx,
      'select min(attempts) as attempts, bool_and(next_attempt_at > ?) as due_later from outbox_messages where id in (?, ?, ?, ?)',
      [clock.now(), ...ids],
    );
    expect(state).toEqual({ attempts: 1, due_later: true });

    const online = new PublishOutbox(ctx.uow, publisherFor(), clock, 50);
    expect((await online.publishBatch()).claimed).toBe(0);
    clock.advance(2_000);
    expect(await online.publishBatch()).toEqual({ claimed: 4, published: 4, failed: 0 });
    expect((await drainQueue(sqs, queue.url, 4)).map((m) => m.body.eventId).sort()).toEqual([...ids].sort());
  });

  it('processo que morre depois de publicar e antes do commit: outra instância republica, e a duplicata é inofensiva', async () => {
    const ids = await produceEvents();
    const crashing: EventPublisher = {
      publish: async (messages) => {
        await publisherFor().publish(messages);
        throw new Error('processo morreu antes do commit');
      },
    };

    await expect(new PublishOutbox(ctx.uow, crashing, new TestClock(), 50).publishBatch()).rejects.toThrow('processo morreu');
    expect(await pendingIds()).toEqual(ids);

    expect(await new PublishOutbox(ctx.uow, publisherFor(), new TestClock(), 50).publishBatch()).toMatchObject({ published: 4 });
    expect(await pendingIds()).toEqual([]);

    // o broker pode ou não descartar a repetição; o consumidor deduplica pelo eventId
    const received = await drainQueue(sqs, queue.url);
    const byEventId = new Map<string, string[]>();
    for (const message of received) {
      byEventId.set(message.body.eventId, [...(byEventId.get(message.body.eventId) ?? []), JSON.stringify(message.body)]);
    }
    expect([...byEventId.keys()].sort()).toEqual([...ids].sort());
    for (const bodies of byEventId.values()) {
      expect(new Set(bodies).size).toBe(1);
    }
  });
});
