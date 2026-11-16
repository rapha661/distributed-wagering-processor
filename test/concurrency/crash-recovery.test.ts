import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-types';
import { bet, createTestContext, expectConsistent, openWallet, sql, type TestContext, wager } from '../integration/support/context';
import { queueDepth, testSqsClient } from '../integration/support/sqs';
import {
  createInstanceQueues,
  type Instance,
  type InstanceQueues,
  instanceEnv,
  queueIsEmpty,
  sendMessages,
  startInstance,
  waitFor,
  wagerMessage,
} from './support/instances';

let ctx: TestContext;
let sqs: SQSClient;
const started: Instance[] = [];
const createdQueues: InstanceQueues[] = [];

beforeAll(async () => {
  ctx = await createTestContext();
  sqs = testSqsClient();
});

afterEach(async () => {
  await Promise.all(started.splice(0).map((instance) => instance.kill()));
  await Promise.all(createdQueues.splice(0).map((queues) => queues.remove()));
});

afterAll(async () => {
  await ctx.close();
  sqs.destroy();
});

async function queues(visibilityTimeoutSeconds: number) {
  const created = await createInstanceQueues(sqs, visibilityTimeoutSeconds);
  createdQueues.push(created);
  return created;
}

async function start(name: string, env: Record<string, string>) {
  const instance = await startInstance(name, env);
  started.push(instance);
  return instance;
}

const countWhere = async (query: string, params: unknown[]) =>
  (await sql<{ n: number }>(ctx, `select count(*)::int as n from ${query}`, params))[0]?.n ?? 0;

const balanceOf = async (walletId: string) => (await ctx.queries.getWallet(walletId)).balance.amount;

describe('queda e recuperação com processos reais', () => {
  it('worker morto depois do commit e antes do ack: outra instância conclui sem duplicar', async () => {
    const q = await queues(2);
    const wallet = await openWallet(ctx, '100.00');
    const message = wagerMessage(bet(wallet, '25.00'));
    const key = message.data.idempotencyKey;

    // a outbox desta instância não roda a tempo: ela morre antes de publicar
    const doomed = await start('doomed', instanceEnv(q, { FAULT_INJECTION: 'crash-after-commit', OUTBOX_POLL_INTERVAL_MS: '60000' }));
    await sendMessages(sqs, q.source, [message]);
    expect(await doomed.exited).toBe(137);

    // o commit aconteceu, o ack e a publicação não
    expect(await sql(ctx, 'select status from wager_transactions where idempotency_key = ?', [key])).toMatchObject([
      { status: 'PROCESSED' },
    ]);
    expect(await balanceOf(wallet.id)).toBe('75.00');
    expect((await queueDepth(sqs, q.source.url)).inFlight).toBe(1);
    const unpublished = `outbox_messages where payload->>'causationId' = ? and published_at is null`;
    expect(await countWhere(unpublished, [message.messageId])).toBe(2);

    const survivor = await start('survivor', instanceEnv(q));
    await waitFor(
      async () => (await queueIsEmpty(sqs, q.source)) && (await countWhere(unpublished, [message.messageId])) === 0,
      20_000,
      'redelivery and outbox',
    );

    // a redelivery é registrada no log com os ids de correlação e sem valores
    const redelivery = survivor.logs().find((line) => line.msg === 'wager message processed' && line.messageId === message.messageId);
    expect(redelivery).toMatchObject({
      level: 'info',
      correlationId: message.messageId,
      transactionId: expect.any(String),
      walletId: wallet.id,
      providerId: 'provider-a',
      status: 'PROCESSED',
      idempotentReplay: true,
    });
    expect(survivor.output()).not.toContain('"amount"');
    expect(await balanceOf(wallet.id)).toBe('75.00');
    expect(await countWhere('wager_transactions where idempotency_key = ?', [key])).toBe(1);
    expect(await countWhere('wallet_ledger_entries where wallet_id = ?', [wallet.id])).toBe(2);
    expect(await countWhere('inbox_messages where message_id = ?', [message.messageId])).toBe(1);
    expect(await countWhere(`outbox_messages where payload->>'causationId' = ?`, [message.messageId])).toBe(2);
    await expectConsistent(ctx, wallet.id);
  }, 60_000);

  it('reinício: derrubar todas as instâncias no meio do processamento e subir de novo termina consistente', async () => {
    const q = await queues(2);
    const wallets = await Promise.all(Array.from({ length: 6 }, () => openWallet(ctx, '1000.00')));
    const messages = wallets.flatMap((wallet) => {
      const bets = Array.from({ length: 30 }, () => bet(wallet, '1.00'));
      // os REFUNDs chegam antes das BETs que referenciam (PENDING_REFERENCE até elas chegarem)
      const refunds = bets.slice(-5).map((reference) =>
        wager(wallet, WagerTransactionKind.Refund, '1.00', {
          referenceExternalTransactionId: reference.request.externalTransactionId,
        }),
      );
      const wins = Array.from({ length: 10 }, () => wager(wallet, WagerTransactionKind.Win, '2.00'));
      return [...refunds, ...bets, ...wins].map((command) => wagerMessage(command));
    });
    const keys = messages.map((message) => message.data.idempotencyKey);
    const processed = () => countWhere(`wager_transactions where idempotency_key in (?) and status = 'PROCESSED'`, [keys]);

    const first = await Promise.all([1, 2, 3].map((n) => start(`first-${n}`, instanceEnv(q))));
    await sendMessages(sqs, q.source, messages);
    await waitFor(async () => (await processed()) >= 40, 30_000, 'first instances to start processing');
    await Promise.all(first.map((instance) => instance.kill()));

    const processedAtCrash = await processed();
    expect(processedAtCrash).toBeLessThan(messages.length);

    await Promise.all([1, 2, 3].map((n) => start(`second-${n}`, instanceEnv(q))));
    await waitFor(
      async () =>
        (await processed()) === messages.length &&
        (await queueIsEmpty(sqs, q.source)) &&
        (await countWhere(`outbox_messages where aggregate_id in (?) and published_at is null`, [wallets.map((w) => w.id)])) === 0,
      60_000,
      'recovery after restart',
    );

    expect(await countWhere('wager_transactions where idempotency_key in (?)', [keys])).toBe(messages.length);
    expect(await countWhere('inbox_messages where message_id in (?)', [messages.map((m) => m.messageId)])).toBe(messages.length);
    expect(await queueIsEmpty(sqs, q.deadLetter)).toBe(true);
    for (const wallet of wallets) {
      // 1000 - 30 apostas + 5 estornos + 10 ganhos de 2.00
      expect(await balanceOf(wallet.id)).toBe('995.00');
      expect(await countWhere('wallet_ledger_entries where wallet_id = ?', [wallet.id])).toBe(1 + 45);
      await expectConsistent(ctx, wallet.id);
    }
  }, 120_000);

  it.skipIf(process.platform === 'win32')(
    'SIGTERM: conclui a mensagem em andamento, devolve as demais e não deixa nada preso na fila',
    async () => {
      const q = await queues(30);
      const wallets = await Promise.all(Array.from({ length: 4 }, () => openWallet(ctx, '1000.00')));
      const messages = wallets.flatMap((wallet) => Array.from({ length: 50 }, () => wagerMessage(bet(wallet, '1.00'))));
      const keys = messages.map((message) => message.data.idempotencyKey);
      const processed = () => countWhere('wager_transactions where idempotency_key in (?)', [keys]);

      const instance = await start('graceful', instanceEnv(q, { APP_ROLE: 'worker' }));
      await sendMessages(sqs, q.source, messages);
      await waitFor(async () => (await processed()) >= 20, 30_000, 'processing to start');
      await instance.terminate();

      expect(instance.output()).toContain('wager consumer stopped');
      // nada ficou invisível esperando o visibility timeout: tudo foi concluído ou devolvido
      expect((await queueDepth(sqs, q.source.url)).inFlight).toBe(0);
      expect(await processed()).toBeLessThan(messages.length);

      await start('next', instanceEnv(q, { APP_ROLE: 'worker' }));
      await waitFor(
        async () => (await processed()) === messages.length && (await queueIsEmpty(sqs, q.source)),
        60_000,
        'remaining messages',
      );
      for (const wallet of wallets) {
        expect(await balanceOf(wallet.id)).toBe('950.00');
        await expectConsistent(ctx, wallet.id);
      }
    },
    120_000,
  );
});
