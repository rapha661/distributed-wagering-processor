import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { SubmitWagerCommand } from '../../src/application/process-wager-transaction';
import { bet, createTestContext, expectConsistent, openWallet, sql, type TestContext } from '../integration/support/context';
import { testSqsClient } from '../integration/support/sqs';
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

// Três processos reais da aplicação, cada um com o próprio pool de conexões, disputando as
// mesmas wallets pela API e consumindo a mesma fila.

let ctx: TestContext;
let sqs: SQSClient;
let queues: InstanceQueues;
let instances: Instance[] = [];

beforeAll(async () => {
  ctx = await createTestContext();
  sqs = testSqsClient();
  queues = await createInstanceQueues(sqs);
  instances = await Promise.all([1, 2, 3].map((n) => startInstance(`instance-${n}`, instanceEnv(queues))));
}, 60_000);

afterAll(async () => {
  await Promise.all(instances.map((instance) => instance.kill()));
  await queues.remove();
  await ctx.close();
  sqs.destroy();
});

const instanceAt = (index: number) => instances[index % instances.length] as Instance;

async function submit(instance: Instance, command: SubmitWagerCommand) {
  const response = await fetch(`${instance.url}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': command.idempotencyKey },
    body: JSON.stringify(command.request),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

const debitsOf = async (walletId: string) =>
  (
    await sql<{ total: number }>(
      ctx,
      `select count(*)::int as total from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`,
      [walletId],
    )
  )[0]?.total;

const balanceOf = async (walletId: string) => (await ctx.queries.getWallet(walletId)).balance.amount;

describe('três instâncias simultâneas', () => {
  it('a mesma aposta enviada em paralelo às 3 instâncias gera um único débito', async () => {
    const wallet = await openWallet(ctx, '1000.00');
    const command = bet(wallet, '25.00');

    const responses = await Promise.all(Array.from({ length: 30 }, (_, i) => submit(instanceAt(i), command)));

    expect(responses.every((response) => response.status === 201)).toBe(true);
    expect(new Set(responses.map((response) => response.body.transactionId)).size).toBe(1);
    expect(responses.filter((response) => !response.body.idempotentReplay)).toHaveLength(1);
    expect(await debitsOf(wallet.id)).toBe(1);
    expect(await balanceOf(wallet.id)).toBe('975.00');
    await expectConsistent(ctx, wallet.id);

    // cada submissão gera uma linha de log JSON correlacionada, sem valores
    const transactionId = responses[0]?.body.transactionId;
    const logged = () =>
      instances
        .flatMap((instance) => instance.logs())
        .filter((line) => line.msg === 'wager transaction submitted' && line.transactionId === transactionId);
    await waitFor(async () => logged().length === 30, 5_000, 'request logs');
    expect(logged().every((line) => line.walletId === wallet.id && line.providerId === 'provider-a' && line.correlationId)).toBe(true);
    expect(logged().filter((line) => !line.idempotentReplay)).toHaveLength(1);
    expect(instances.some((instance) => instance.output().includes('"amount"'))).toBe(false);
  });

  it('cenário obrigatório entre instâncias: 100.00 e duas apostas de 80.00 (20 rodadas)', async () => {
    for (let round = 0; round < 20; round++) {
      const wallet = await openWallet(ctx, '100.00');

      const responses = await Promise.all([
        submit(instanceAt(round), bet(wallet, '80.00')),
        submit(instanceAt(round + 1), bet(wallet, '80.00')),
      ]);

      expect(responses.map((response) => response.status).sort()).toEqual([201, 422]);
      expect(responses.find((response) => response.status === 422)?.body.failureCode).toBe('INSUFFICIENT_FUNDS');
      expect(await balanceOf(wallet.id)).toBe('20.00');
      expect(await debitsOf(wallet.id)).toBe(1);
      await expectConsistent(ctx, wallet.id);
    }
  }, 30_000);

  it('as 3 instâncias consomem a mesma fila sem perder nem duplicar', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => openWallet(ctx, '1000.00')));
    const messages = wallets.flatMap((wallet) => Array.from({ length: 15 }, () => wagerMessage(bet(wallet, '1.00'))));
    const keys = messages.map((message) => message.data.idempotencyKey);

    // cada mensagem chega duas vezes
    await sendMessages(sqs, queues.source, [...messages, ...messages]);

    const processed = async () =>
      (await sql<{ n: number }>(ctx, 'select count(*)::int as n from wager_transactions where idempotency_key in (?)', [keys]))[0]?.n ?? 0;
    await waitFor(async () => (await processed()) === messages.length && (await queueIsEmpty(sqs, queues.source)), 60_000, 'queue to drain');

    for (const wallet of wallets) {
      expect(await balanceOf(wallet.id)).toBe('985.00');
      expect(await debitsOf(wallet.id)).toBe(15);
      await expectConsistent(ctx, wallet.id);
    }
    const [inbox] = await sql<{ n: number }>(ctx, 'select count(*)::int as n from inbox_messages where message_id in (?)', [
      messages.map((message) => message.messageId),
    ]);
    expect(inbox?.n).toBe(messages.length);
    expect(await queueIsEmpty(sqs, queues.deadLetter)).toBe(true);

    // o trabalho foi de fato dividido entre os processos
    const consumers = instances.filter((instance) => messages.some((message) => instance.output().includes(message.messageId)));
    expect(consumers.length).toBeGreaterThanOrEqual(2);
  }, 90_000);
});
