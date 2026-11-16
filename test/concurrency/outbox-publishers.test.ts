import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher } from '../../src/application/ports';
import { PublishOutbox } from '../../src/application/publish-outbox';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { TestClock } from '../integration/support/clock';
import { bet, createTestContext, openWallet, sql, type TestContext } from '../integration/support/context';
import { createTestQueue, drainQueue, type TestQueue, testSqsClient } from '../integration/support/sqs';

let ctx: TestContext;
let sqs: SQSClient;
let queue: TestQueue;

beforeAll(async () => {
  ctx = await createTestContext();
  sqs = testSqsClient();
  queue = await createTestQueue(sqs, 'test-publishers');
  await sql(ctx, 'update outbox_messages set published_at = now() where published_at is null');
});

afterAll(async () => {
  await queue.remove();
  sqs.destroy();
  await ctx.close();
});

describe('dois publishers sobre a mesma outbox', () => {
  it('cada evento é entregue a um único publisher e nenhum se perde', async () => {
    await Promise.all(
      Array.from({ length: 15 }, async () => {
        const wallet = await openWallet(ctx, '100.00');
        await ctx.process.execute(bet(wallet, '1.00'));
      }),
    );
    const expected = (await sql<{ id: string }>(ctx, 'select id from outbox_messages where published_at is null')).map((r) => r.id);
    expect(expected).toHaveLength(60);

    const handled = [new Array<string>(), new Array<string>()];
    const recording = (index: number): EventPublisher => {
      const sqsPublisher = new SqsEventPublisher(sqs, queue.name, 2_000);
      return {
        publish: async (messages) => {
          handled[index]?.push(...messages.map((m) => m.id));
          await Bun.sleep(20); // segura o lote travado para forçar a disputa
          return sqsPublisher.publish(messages);
        },
      };
    };

    const run = async (index: number) => {
      const publisher = new PublishOutbox(ctx.uow, recording(index), new TestClock(), 7);
      while ((await publisher.publishBatch()).claimed > 0) {
        // continua até a outbox esvaziar
      }
    };
    await Promise.all([run(0), run(1)]);

    const [first = [], second = []] = handled;
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
    expect(first.filter((id) => second.includes(id))).toEqual([]);
    expect([...first, ...second].sort()).toEqual([...expected].sort());
    expect(await sql(ctx, 'select 1 from outbox_messages where published_at is null')).toHaveLength(0);

    const received = await drainQueue(sqs, queue.url, expected.length);
    expect(new Set(received.map((m) => m.body.eventId as string))).toEqual(new Set(expected));
  });
});
