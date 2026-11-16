import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { createTestContext, expectConsistent, holdWalletLock, sql, type TestContext } from './support/context';
import { TEST_DATABASE_URL } from './support/database';

let app: INestApplication;
let baseUrl: string;
let ctx: TestContext;
const touched = new Set<string>();
const previousEnv = { ...process.env };

interface ApiResponse {
  status: number;
  body: any;
  headers: Headers;
}

async function api(method: string, path: string, options: { body?: unknown; raw?: string; headers?: Record<string, string> } = {}): Promise<ApiResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...options.headers },
    body: options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined, headers: response.headers };
}

async function createWallet(amount = '100.00') {
  const response = await api('POST', '/wallets', {
    body: { playerId: crypto.randomUUID(), initialBalance: { amount, currency: 'BRL' } },
  });
  expect(response.status).toBe(201);
  touched.add(response.body.id);
  return response.body as { id: string; playerId: string };
}

function wagerBody(wallet: { id: string; playerId: string }, kind: string, amount: string, extra: Record<string, unknown> = {}) {
  return {
    providerId: 'provider-a',
    externalTransactionId: `tx-${crypto.randomUUID()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...extra,
  };
}

const submit = (body: { providerId: string; externalTransactionId: string }, key = `${body.providerId}:${body.externalTransactionId}`) =>
  api('POST', '/wagering/transactions', { body, headers: { 'Idempotency-Key': key } });

beforeAll(async () => {
  ctx = await createTestContext();
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.DATABASE_LOCK_TIMEOUT_MS = '300';
  process.env.LOG_LEVEL = 'silent';
  // sem workers: estes testes cobrem só a API
  process.env.APP_ROLE = 'api';
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const walletId of touched) {
    await expectConsistent(ctx, walletId);
  }
  touched.clear();
});

afterAll(async () => {
  await app.close();
  await ctx.close();
  process.env = previousEnv;
});

describe('POST /wallets', () => {
  it('201 com o saldo inicial e version 1', async () => {
    const playerId = crypto.randomUUID();
    const response = await api('POST', '/wallets', {
      body: { playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } },
      headers: { 'X-Correlation-Id': 'corr-123' },
    });
    touched.add(response.body.id);
    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      id: expect.any(String),
      playerId,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
    expect(response.headers.get('x-correlation-id')).toBe('corr-123');
  });

  it('409 para wallet duplicada', async () => {
    const wallet = await createWallet();
    const response = await api('POST', '/wallets', {
      body: { playerId: wallet.playerId, initialBalance: { amount: '1.00', currency: 'BRL' } },
    });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('WALLET_ALREADY_EXISTS');
  });

  it('400 para payload ou valor inválido', async () => {
    const invalidMoney = await api('POST', '/wallets', {
      body: { playerId: crypto.randomUUID(), initialBalance: { amount: '10.005', currency: 'BRL' } },
    });
    expect(invalidMoney).toMatchObject({ status: 400, body: { code: 'INVALID_MONEY' } });

    const invalidPlayer = await api('POST', '/wallets', { body: { playerId: 'x', initialBalance: { amount: '1.00', currency: 'BRL' } } });
    expect(invalidPlayer).toMatchObject({ status: 400, body: { code: 'INVALID_PAYLOAD' } });
    expect(invalidPlayer.body.details[0].path).toBe('playerId');

    const malformed = await api('POST', '/wallets', { raw: '{"playerId":' });
    expect(malformed).toMatchObject({ status: 400, body: { code: 'INVALID_PAYLOAD' } });
  });
});

describe('POST /wagering/transactions', () => {
  it('201 processada, e o replay devolve a mesma resposta com idempotentReplay', async () => {
    const wallet = await createWallet('1000.00');
    const body = wagerBody(wallet, 'BET', '25.00');

    const first = await submit(body);
    expect(first.status).toBe(201);
    expect(first.body).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: { amount: '975.00', currency: 'BRL' },
      idempotentReplay: false,
    });

    const replay = await submit(body);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  it('409 para a mesma key com payload diferente', async () => {
    const wallet = await createWallet();
    const body = wagerBody(wallet, 'BET', '10.00');
    await submit(body);
    const response = await submit({ ...body, money: { amount: '11.00', currency: 'BRL' } } as typeof body);
    expect(response).toMatchObject({ status: 409, body: { code: 'IDEMPOTENCY_KEY_REUSED' } });
  });

  it('422 para rejeição por regra de negócio, com failureCode', async () => {
    const wallet = await createWallet('10.00');
    const response = await submit(wagerBody(wallet, 'BET', '25.00'));
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: { amount: '10.00', currency: 'BRL' },
      idempotentReplay: false,
    });
  });

  it('202 quando a referência ainda não chegou', async () => {
    const wallet = await createWallet();
    const response = await submit(wagerBody(wallet, 'REFUND', '10.00', { referenceExternalTransactionId: 'bet-futura' }));
    expect(response).toMatchObject({ status: 202, body: { status: 'PENDING_REFERENCE' } });
  });

  it('400 para key ausente, OPENING, provedor reservado e valor inválido', async () => {
    const wallet = await createWallet();
    const noKey = await api('POST', '/wagering/transactions', { body: wagerBody(wallet, 'BET', '1.00') });
    expect(noKey).toMatchObject({ status: 400, body: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });

    expect(await submit(wagerBody(wallet, 'OPENING', '1.00'))).toMatchObject({ status: 400, body: { code: 'INVALID_PAYLOAD' } });
    expect(await submit(wagerBody(wallet, 'BET', '1.00', { providerId: 'internal' }))).toMatchObject({
      status: 400,
      body: { code: 'INVALID_PAYLOAD' },
    });
    expect(await submit(wagerBody(wallet, 'BET', '1e3'))).toMatchObject({ status: 400, body: { code: 'INVALID_MONEY' } });
    expect(await submit({ ...wagerBody(wallet, 'BET', '1.00'), money: { amount: 1, currency: 'BRL' } } as never)).toMatchObject({
      status: 400,
      body: { code: 'INVALID_PAYLOAD' },
    });
    expect(await submit(wagerBody(wallet, 'REFUND', '1.00'))).toMatchObject({ status: 400, body: { code: 'MISSING_REFERENCE' } });
  });

  it('404 para wallet inexistente', async () => {
    const response = await submit(wagerBody({ id: crypto.randomUUID(), playerId: crypto.randomUUID() }, 'BET', '1.00'));
    expect(response).toMatchObject({ status: 404, body: { code: 'WALLET_NOT_FOUND' } });
  });

  it('503 com Retry-After quando a wallet está travada por mais que o timeout', async () => {
    const wallet = await createWallet();
    const lock = await holdWalletLock(ctx, wallet.id);
    try {
      const response = await submit(wagerBody(wallet, 'BET', '1.00'));
      expect(response).toMatchObject({ status: 503, body: { code: 'LOCK_TIMEOUT' } });
      expect(response.headers.get('retry-after')).toBe('1');
    } finally {
      await lock.release();
    }
  });
});

describe('consultas', () => {
  it('GET /wallets/:id', async () => {
    const wallet = await createWallet('50.00');
    const response = await api('GET', `/wallets/${wallet.id}`);
    expect(response).toMatchObject({ status: 200, body: { id: wallet.id, balance: { amount: '50.00' }, version: 1 } });

    expect(await api('GET', `/wallets/${crypto.randomUUID()}`)).toMatchObject({ status: 404, body: { code: 'WALLET_NOT_FOUND' } });
    expect(await api('GET', '/wallets/nao-e-uuid')).toMatchObject({ status: 400, body: { code: 'INVALID_PARAMETER' } });
  });

  it('GET /wallets/:id/ledger pagina com cursor estável', async () => {
    const wallet = await createWallet('100.00');
    for (const amount of ['1.00', '2.00', '3.00']) {
      await submit(wagerBody(wallet, 'BET', amount));
    }

    const first = await api('GET', `/wallets/${wallet.id}/ledger?limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.items.map((e: { walletVersion: number }) => e.walletVersion)).toEqual([4, 3]);
    expect(first.body.items[0]).toMatchObject({ direction: 'DEBIT', money: { amount: '3.00' }, balanceAfter: { amount: '94.00' } });

    const second = await api('GET', `/wallets/${wallet.id}/ledger?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.items.map((e: { walletVersion: number }) => e.walletVersion)).toEqual([2, 1]);
    expect(second.body.nextCursor).toBeNull();

    expect(await api('GET', `/wallets/${wallet.id}/ledger?cursor=lixo`)).toMatchObject({ status: 400, body: { code: 'INVALID_CURSOR' } });
    expect(await api('GET', `/wallets/${wallet.id}/ledger?limit=0`)).toMatchObject({ status: 400, body: { code: 'INVALID_PARAMETER' } });
  });

  it('GET de transação por id e por (provider, id externo)', async () => {
    const wallet = await createWallet();
    const body = wagerBody(wallet, 'BET', '5.00');
    const submitted = await submit(body);

    const byId = await api('GET', `/wagering/transactions/${submitted.body.transactionId}`);
    expect(byId).toMatchObject({
      status: 200,
      body: { id: submitted.body.transactionId, kind: 'BET', status: 'PROCESSED', money: { amount: '5.00' }, balance: { amount: '95.00' } },
    });

    const byExternal = await api('GET', `/providers/provider-a/wagering/transactions/${body.externalTransactionId}`);
    expect(byExternal).toMatchObject({ status: 200, body: { id: submitted.body.transactionId } });

    expect(await api('GET', `/providers/provider-a/wagering/transactions/nao-existe`)).toMatchObject({
      status: 404,
      body: { code: 'TRANSACTION_NOT_FOUND' },
    });
  });

  it('POST /wallets/:id/reconciliation', async () => {
    const wallet = await createWallet('100.00');
    await submit(wagerBody(wallet, 'BET', '25.00'));
    const response = await api('POST', `/wallets/${wallet.id}/reconciliation`);
    expect(response).toMatchObject({
      status: 200,
      body: {
        walletId: wallet.id,
        storedBalance: { amount: '75.00', currency: 'BRL' },
        calculatedBalance: { amount: '75.00', currency: 'BRL' },
        difference: { amount: '0.00', currency: 'BRL' },
        consistent: true,
        checkedEntries: 2,
      },
    });
  });

  it('health fica aberto', async () => {
    expect(await api('GET', '/health/live')).toMatchObject({ status: 200, body: { status: 'ok' } });
  });
});

describe('GET /metrics', () => {
  async function scrape(): Promise<Map<string, number>> {
    const response = await fetch(`${baseUrl}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    const samples = new Map<string, number>();
    for (const line of (await response.text()).split('\n')) {
      const match = /^(\S+) (\S+)$/.exec(line);
      if (match && !line.startsWith('#')) {
        samples.set(match[1] as string, Number(match[2]));
      }
    }
    return samples;
  }

  it('expõe transações por status, duplicatas, latência, conflitos de lock, divergências e backlog', async () => {
    const before = await scrape();
    const wallet = await createWallet('100.00');
    const bet = wagerBody(wallet, 'BET', '10.00');
    await submit(bet);
    await submit(bet);
    await submit(wagerBody(wallet, 'BET', '500.00'));
    const lock = await holdWalletLock(ctx, wallet.id);
    try {
      expect((await submit(wagerBody(wallet, 'BET', '1.00'))).status).toBe(503);
    } finally {
      await lock.release();
    }
    // wallet adulterada de propósito (fora de `touched`): a reconciliação tem que acusar
    const tampered = await api('POST', '/wallets', {
      body: { playerId: crypto.randomUUID(), initialBalance: { amount: '10.00', currency: 'BRL' } },
    });
    await sql(ctx, 'update wallets set balance = balance + 1 where id = ?', [tampered.body.id]);
    expect(await api('POST', `/wallets/${tampered.body.id}/reconciliation`)).toMatchObject({ body: { consistent: false } });

    const after = await scrape();
    const delta = (sample: string) => (after.get(sample) ?? 0) - (before.get(sample) ?? 0);
    expect(delta('wager_transactions_total{status="PROCESSED",source="http"}')).toBe(1);
    expect(delta('wager_transactions_total{status="REJECTED",source="http"}')).toBe(1);
    expect(delta('wager_duplicates_total{source="http"}')).toBe(1);
    expect(delta('wager_processing_duration_seconds_count{source="http"}')).toBe(3);
    expect(delta('wallet_lock_conflicts_total')).toBe(1);
    expect(delta('wallet_reconciliation_mismatches_total')).toBe(1);
    for (const gauge of ['outbox_pending_messages', 'outbox_lag_seconds', 'wager_pending_reference_transactions', 'wager_dead_letter_queue_messages']) {
      expect(Number.isFinite(after.get(gauge))).toBe(true);
    }
  });
});
