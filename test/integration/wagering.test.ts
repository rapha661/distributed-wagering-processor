import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  TransientFailureError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../src/application/errors';
import type { UnitOfWork } from '../../src/application/ports';
import { InvalidMoneyError } from '../../src/domain/money/money';
import { InvalidWagerTransactionError } from '../../src/domain/wagering/wager-transaction';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-types';
import { MikroORM } from '@mikro-orm/postgresql';
import { createOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
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

const { Win, Loss, Refund, Rollback } = WagerTransactionKind;

let ctx: TestContext;
const touched = new Set<string>();

async function wallet(amount = '100.00') {
  const created = await openWallet(ctx, amount);
  touched.add(created.id);
  return created;
}

const outboxOf = (aggregateIds: string[]) =>
  sql<{ event_type: string }>(
    ctx,
    `select event_type from outbox_messages where aggregate_id in (${aggregateIds.map(() => '?').join(',')}) order by event_type`,
    aggregateIds,
  ).then((rows) => rows.map((row) => row.event_type));

const ledgerOf = (walletId: string) =>
  sql<{ direction: string; amount: string }>(
    ctx,
    'select direction, amount::text as amount from wallet_ledger_entries where wallet_id = ? order by wallet_version',
    [walletId],
  );

beforeAll(async () => {
  ctx = await createTestContext();
});

afterEach(async () => {
  for (const walletId of touched) {
    await expectConsistent(ctx, walletId);
  }
  touched.clear();
});

afterAll(async () => {
  await ctx.close();
});

describe('criação de wallet', () => {
  it('saldo inicial gera OPENING, lançamento CREDIT e eventos na mesma transação', async () => {
    const created = await wallet('1000.00');
    expect(created).toMatchObject({ balance: { amount: '1000.00', currency: 'BRL' }, version: 1 });

    const [opening] = await sql<{ id: string; kind: string; status: string }>(
      ctx,
      'select id, kind, status from wager_transactions where wallet_id = ?',
      [created.id],
    );
    expect(opening).toMatchObject({ kind: 'OPENING', status: 'PROCESSED' });
    expect(await ledgerOf(created.id)).toEqual([{ direction: 'CREDIT', amount: '1000.00' }]);
    expect(await outboxOf([created.id, opening?.id ?? ''])).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  it('saldo inicial zero não gera transação nem lançamento', async () => {
    const created = await wallet('0.00');
    expect(created.version).toBe(1);
    expect(await sql(ctx, 'select 1 from wager_transactions where wallet_id = ?', [created.id])).toHaveLength(0);
    expect(await ledgerOf(created.id)).toHaveLength(0);
  });

  it('wallet duplicada para o mesmo jogador e moeda é conflito', async () => {
    const created = await wallet();
    const duplicate = ctx.createWallet.execute({
      playerId: created.playerId,
      initialBalance: { amount: '50.00', currency: 'BRL' },
      correlationId: 't',
    });
    await expect(duplicate).rejects.toBeInstanceOf(WalletAlreadyExistsError);
  });

  it('rejeita saldo inicial inválido', async () => {
    const invalid = ctx.createWallet.execute({
      playerId: crypto.randomUUID(),
      initialBalance: { amount: '-1.00', currency: 'BRL' },
      correlationId: 't',
    });
    await expect(invalid).rejects.toBeInstanceOf(InvalidMoneyError);
  });
});

describe('submissão de transação', () => {
  it('BET debita, grava lançamento e eventos', async () => {
    const w = await wallet('1000.00');
    const result = await ctx.process.execute(bet(w, '25.00'));

    expect(result).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '975.00', currency: 'BRL' },
      failureCode: null,
      idempotentReplay: false,
    });
    expect((await ledgerOf(w.id)).at(-1)).toEqual({ direction: 'DEBIT', amount: '25.00' });
    expect(await outboxOf([result.transactionId, w.id])).toContain('WalletBalanceChanged');
  });

  it('requisição idêntica devolve o resultado original como replay, sem gravar nada', async () => {
    const w = await wallet('100.00');
    const command = bet(w, '30.00');
    const first = await ctx.process.execute(command);
    await ctx.process.execute(bet(w, '10.00'));

    const replay = await ctx.process.execute(command);
    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(replay.balance).toEqual({ amount: '70.00', currency: 'BRL' });
    expect(await ledgerOf(w.id)).toHaveLength(3);
  });

  it('mesma key com payload diferente é conflito, não replay', async () => {
    const w = await wallet('100.00');
    const command = bet(w, '30.00');
    await ctx.process.execute(command);

    const conflict = ctx.process.execute({ ...command, request: { ...command.request, money: { amount: '31.00', currency: 'BRL' } } });
    await expect(conflict).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await ledgerOf(w.id)).toHaveLength(2);
  });

  it('mesmo externalTransactionId com outra key é conflito', async () => {
    const w = await wallet('100.00');
    const command = bet(w, '30.00');
    await ctx.process.execute(command);
    const conflict = ctx.process.execute({ ...command, idempotencyKey: 'outra-key' });
    await expect(conflict).rejects.toBeInstanceOf(ExternalTransactionConflictError);
  });

  it('saldo insuficiente é rejeitado, auditável e sem lançamento', async () => {
    const w = await wallet('10.00');
    const result = await ctx.process.execute(bet(w, '10.01'));
    expect(result).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: '10.00' } });
    expect(await ledgerOf(w.id)).toHaveLength(1);
    expect(await outboxOf([result.transactionId])).toEqual(['WagerTransactionRejected']);
  });

  it('LOSS é processada sem mexer no saldo nem na versão', async () => {
    const w = await wallet('100.00');
    const result = await ctx.process.execute(wager(w, Loss, '0.00'));
    expect(result).toMatchObject({ status: 'PROCESSED' });
    expect((await ctx.queries.getWallet(w.id)).version).toBe(1);
    expect(await outboxOf([result.transactionId])).toEqual(['WagerTransactionProcessed']);
  });

  it('WIN credita', async () => {
    const w = await wallet('100.00');
    const result = await ctx.process.execute(wager(w, Win, '40.00'));
    expect(result.balance).toEqual({ amount: '140.00', currency: 'BRL' });
  });

  it('REFUND reverte a BET uma única vez, por qualquer tipo', async () => {
    const w = await wallet('100.00');
    const betCommand = bet(w, '40.00');
    await ctx.process.execute(betCommand);
    const reference = { referenceExternalTransactionId: betCommand.request.externalTransactionId };

    const refund = await ctx.process.execute(wager(w, Refund, '40.00', reference));
    const second = await ctx.process.execute(wager(w, Refund, '40.00', reference));
    const rollback = await ctx.process.execute(wager(w, Rollback, '40.00', reference));

    expect(refund).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00' } });
    expect(second).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_ALREADY_REVERSED' });
    expect(rollback).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_ALREADY_REVERSED' });
  });

  it('ROLLBACK de WIN sem saldo é rejeitado com código próprio', async () => {
    const w = await wallet('100.00');
    const win = wager(w, Win, '50.00');
    await ctx.process.execute(win);
    await ctx.process.execute(bet(w, '120.00'));

    const result = await ctx.process.execute(
      wager(w, Rollback, '50.00', { referenceExternalTransactionId: win.request.externalTransactionId }),
    );
    expect(result).toMatchObject({ status: 'REJECTED', failureCode: 'REVERSAL_INSUFFICIENT_FUNDS', balance: { amount: '30.00' } });
  });

  it('REFUND antes da BET fica PENDING_REFERENCE e publica evento', async () => {
    const w = await wallet('100.00');
    const result = await ctx.process.execute(
      wager(w, Refund, '40.00', { referenceExternalTransactionId: `bet-${crypto.randomUUID()}` }),
    );
    expect(result).toMatchObject({ status: 'PENDING_REFERENCE', balance: { amount: '100.00' } });
    expect(await outboxOf([result.transactionId])).toEqual(['WagerTransactionPendingReference']);
  });

  it('jogador que não é o dono da wallet é rejeitado sem expor o saldo', async () => {
    const w = await wallet('100.00');
    const result = await ctx.process.execute(bet(w, '10.00', { playerId: crypto.randomUUID() }));
    expect(result).toMatchObject({ status: 'REJECTED', failureCode: 'PLAYER_WALLET_MISMATCH', balance: null });
  });

  it('moeda diferente da wallet é rejeitada', async () => {
    const w = await wallet('100.00');
    const result = await ctx.process.execute(bet(w, '10.00', { money: { amount: '10.00', currency: 'USD' } }));
    expect(result).toMatchObject({ status: 'REJECTED', failureCode: 'CURRENCY_MISMATCH', balance: null });
  });

  it('wallet inexistente e payload inválido não gravam nada', async () => {
    const missing = ctx.process.execute(bet({ id: crypto.randomUUID(), playerId: crypto.randomUUID() }, '1.00'));
    await expect(missing).rejects.toBeInstanceOf(WalletNotFoundError);

    const w = await wallet('100.00');
    const opening = ctx.process.execute(wager(w, WagerTransactionKind.Opening, '1.00'));
    await expect(opening).rejects.toBeInstanceOf(InvalidWagerTransactionError);
  });
});

describe('atomicidade', () => {
  it('falha no meio da transação não deixa wallet, transação, ledger, inbox nem outbox gravados', async () => {
    const failing = await createTestContext({
      uow: (base): UnitOfWork => ({
        run: (work) =>
          base.run((repos) =>
            work({
              ...repos,
              outbox: {
                add: () => {
                  throw new Error('outbox indisponível');
                },
                claimDue: (now, limit) => repos.outbox.claimDue(now, limit),
                update: (message) => repos.outbox.update(message),
              },
            }),
          ),
      }),
    });
    try {
      const w = await wallet('100.00');
      const command = bet(w, '25.00');
      const delivery = { consumerName: 'test-consumer', messageId: `msg-${crypto.randomUUID()}`, payloadHash: 'a'.repeat(64), receivedAt: new Date() };
      await expect(failing.process.execute(command, delivery)).rejects.toThrow('outbox indisponível');

      expect((await ctx.queries.getWallet(w.id)).balance.amount).toBe('100.00');
      expect(await sql(ctx, 'select 1 from wager_transactions where idempotency_key = ?', [command.idempotencyKey])).toHaveLength(0);
      expect(await ledgerOf(w.id)).toHaveLength(1);
      expect(await sql(ctx, 'select 1 from inbox_messages where message_id = ?', [delivery.messageId])).toHaveLength(0);
    } finally {
      await failing.close();
    }
  });

  it('lock ocupado além do timeout vira falha transitória, sem efeito', async () => {
    const quick = await createTestContext({ lockTimeoutMs: 200 });
    const w = await wallet('100.00');
    const lock = await holdWalletLock(ctx, w.id);
    try {
      await expect(quick.process.execute(bet(w, '10.00'))).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
    } finally {
      await lock.release();
      await quick.close();
    }
    expect(await ledgerOf(w.id)).toHaveLength(1);
  });

  it('banco inacessível vira falha transitória em vez de pendurar a requisição', async () => {
    const orm = await MikroORM.init(
      createOrmConfig({ DATABASE_URL: 'postgres://u:p@10.255.255.1:5432/x', DATABASE_POOL_MAX: 1, DATABASE_CONNECT_TIMEOUT_MS: 300 }),
    );
    try {
      const started = performance.now();
      const run = new MikroOrmUnitOfWork(orm, 1_000).run(async () => 'nunca');
      await expect(run).rejects.toBeInstanceOf(TransientFailureError);
      await expect(run).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
      expect(performance.now() - started).toBeLessThan(3_000);
    } finally {
      await orm.close(true);
    }
  });
});

describe('reconciliação', () => {
  it('confere saldo e ledger', async () => {
    const w = await wallet('100.00');
    await ctx.process.execute(bet(w, '30.00'));
    await ctx.process.execute(wager(w, Win, '5.50'));

    expect(await ctx.queries.reconcile(w.id)).toEqual({
      walletId: w.id,
      storedBalance: { amount: '75.50', currency: 'BRL' },
      calculatedBalance: { amount: '75.50', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 3,
    });
  });

  it('sinaliza divergência sem corrigir', async () => {
    const w = await openWallet(ctx, '100.00');
    await sql(ctx, 'update wallets set balance = 90.00 where id = ?', [w.id]);

    const report = await ctx.queries.reconcile(w.id);
    expect(report).toMatchObject({ consistent: false, difference: { amount: '-10.00' } });
    expect(ctx.mismatches.at(-1)).toMatchObject({ walletId: w.id, difference: '-10.00 BRL' });
    expect((await ctx.queries.getWallet(w.id)).balance.amount).toBe('90.00');
  });
});
