import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ReprocessPendingReferences } from '../../src/application/reprocess-pending-references';
import { BackoffPolicy } from '../../src/domain/shared/backoff-policy';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-types';
import { uuidV7Generator } from '../../src/infrastructure/system';
import { TestClock } from '../integration/support/clock';
import { bet, createTestContext, expectConsistent, openWallet, sql, type TestContext, wager } from '../integration/support/context';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
});

describe('reversão entregue antes da referência', () => {
  it('REFUND e BET simultâneos, resolvidos por dois workers concorrentes, revertem exatamente uma vez', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => openWallet(ctx, '100.00')));
    const refunds = await Promise.all(
      wallets.map(async (wallet) => {
        const betCommand = bet(wallet, '30.00');
        const refundCommand = wager(wallet, WagerTransactionKind.Refund, '30.00', {
          referenceExternalTransactionId: betCommand.request.externalTransactionId,
        });
        // as duas chegam juntas: o REFUND pode ser aplicado na hora ou ficar pendente
        const [refund] = await Promise.all([ctx.process.execute(refundCommand), ctx.process.execute(betCommand)]);
        return refund;
      }),
    );

    const clock = new TestClock();
    clock.advance(2_000);
    const workers = [0, 1].map(
      () => new ReprocessPendingReferences(ctx.uow, clock, uuidV7Generator, new BackoffPolicy(2_000, 300_000, 8)),
    );
    const [a = [], b = []] = await Promise.all(workers.map((w) => w.processDue(1_000)));
    const ours = new Set(refunds.map((r) => r.transactionId));
    const handledA = a.filter((r) => ours.has(r.transactionId)).map((r) => r.transactionId);
    const handledB = b.filter((r) => ours.has(r.transactionId)).map((r) => r.transactionId);
    expect(handledA.filter((id) => handledB.includes(id))).toEqual([]);

    const states = await sql<{ status: string }>(
      ctx,
      `select status from wager_transactions where id in (${refunds.map(() => '?').join(',')})`,
      refunds.map((r) => r.transactionId),
    );
    expect(states.every((s) => s.status === 'PROCESSED')).toBe(true);

    for (const wallet of wallets) {
      expect((await ctx.queries.getWallet(wallet.id)).balance.amount).toBe('100.00');
      const [ledger] = await sql<{ debits: number; credits: number }>(
        ctx,
        `select count(*) filter (where direction = 'DEBIT')::int as debits,
                count(*) filter (where direction = 'CREDIT')::int as credits
           from wallet_ledger_entries where wallet_id = ?`,
        [wallet.id],
      );
      expect(ledger).toEqual({ debits: 1, credits: 2 }); // abertura + refund
      await expectConsistent(ctx, wallet.id);
    }
  });
});
