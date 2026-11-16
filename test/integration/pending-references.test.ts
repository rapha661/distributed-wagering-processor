import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { ReprocessPendingReferences } from '../../src/application/reprocess-pending-references';
import { BackoffPolicy } from '../../src/domain/shared/backoff-policy';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-types';
import { uuidV7Generator } from '../../src/infrastructure/system';
import { TestClock } from './support/clock';
import { bet, createTestContext, expectConsistent, openWallet, sql, type TestContext, wager } from './support/context';

const { Refund, Rollback } = WagerTransactionKind;
const MAX_ATTEMPTS = 8; // o mesmo do contexto de teste

let ctx: TestContext;
const touched = new Set<string>();

function worker(clock: TestClock) {
  return new ReprocessPendingReferences(ctx.uow, clock, uuidV7Generator, new BackoffPolicy(2_000, 300_000, MAX_ATTEMPTS));
}

async function stateOf(transactionId: string) {
  const [row] = await sql<{ status: string; failure_code: string | null; reference_attempts: number; reference_transaction_id: string | null }>(
    ctx,
    'select status, failure_code, reference_attempts, reference_transaction_id from wager_transactions where id = ?',
    [transactionId],
  );
  return row;
}

const eventsOf = async (aggregateId: string) =>
  (await sql<{ event_type: string }>(ctx, 'select event_type from outbox_messages where aggregate_id = ? order by occurred_at, event_type', [aggregateId])).map(
    (row) => row.event_type,
  );

async function wallet(amount = '100.00') {
  const created = await openWallet(ctx, amount);
  touched.add(created.id);
  return created;
}

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

describe('referências fora de ordem', () => {
  it('REFUND que chega antes da BET é aplicado quando a BET chega', async () => {
    const w = await wallet('100.00');
    const betCommand = bet(w, '40.00');
    const refund = await ctx.process.execute(
      wager(w, Refund, '40.00', { referenceExternalTransactionId: betCommand.request.externalTransactionId }),
    );
    expect(refund).toMatchObject({ status: 'PENDING_REFERENCE' });

    const placed = await ctx.process.execute(betCommand);
    const clock = new TestClock();
    clock.advance(2_000);
    await worker(clock).processDue(1_000);

    expect(await stateOf(refund.transactionId)).toMatchObject({
      status: 'PROCESSED',
      reference_transaction_id: placed.transactionId,
      reference_attempts: 1,
    });
    expect((await ctx.queries.getWallet(w.id)).balance.amount).toBe('100.00');
    expect(await eventsOf(refund.transactionId)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionProcessed']);
  });

  it('ROLLBACK que chega antes da BET credita quando a BET chega', async () => {
    const w = await wallet('100.00');
    const betCommand = bet(w, '25.00');
    const rollback = await ctx.process.execute(
      wager(w, Rollback, '25.00', { referenceExternalTransactionId: betCommand.request.externalTransactionId }),
    );
    await ctx.process.execute(betCommand);
    expect((await ctx.queries.getWallet(w.id)).balance.amount).toBe('75.00');

    const clock = new TestClock();
    clock.advance(2_000);
    await worker(clock).processDue(1_000);

    expect(await stateOf(rollback.transactionId)).toMatchObject({ status: 'PROCESSED' });
    expect((await ctx.queries.getWallet(w.id)).balance.amount).toBe('100.00');
  });

  it('não reprocessa antes do vencimento do backoff', async () => {
    const w = await wallet();
    const refund = await ctx.process.execute(wager(w, Refund, '10.00', { referenceExternalTransactionId: `bet-${crypto.randomUUID()}` }));
    await worker(new TestClock()).processDue(1_000);
    expect(await stateOf(refund.transactionId)).toMatchObject({ status: 'PENDING_REFERENCE', reference_attempts: 1 });
  });

  it('referência que nunca chega é rejeitada com REFERENCE_NOT_FOUND ao esgotar as tentativas', async () => {
    const w = await wallet();
    const refund = await ctx.process.execute(wager(w, Refund, '10.00', { referenceExternalTransactionId: `bet-${crypto.randomUUID()}` }));
    const clock = new TestClock();

    for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
      clock.advance(600_000);
      await worker(clock).processDue(1_000);
      expect(await stateOf(refund.transactionId)).toMatchObject({ status: 'PENDING_REFERENCE', reference_attempts: attempt });
    }
    clock.advance(600_000);
    await worker(clock).processDue(1_000);

    expect(await stateOf(refund.transactionId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_FOUND',
      reference_attempts: MAX_ATTEMPTS,
    });
    // a pendência é anunciada uma vez; a rejeição final também publica evento
    expect(await eventsOf(refund.transactionId)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
    expect((await ctx.queries.getWallet(w.id)).balance.amount).toBe('100.00');
  });

  it('referência que chega rejeitada não pode ser revertida', async () => {
    const w = await wallet('10.00');
    const betCommand = bet(w, '40.00');
    const refund = await ctx.process.execute(
      wager(w, Refund, '40.00', { referenceExternalTransactionId: betCommand.request.externalTransactionId }),
    );
    expect(await ctx.process.execute(betCommand)).toMatchObject({ failureCode: 'INSUFFICIENT_FUNDS' });

    const clock = new TestClock();
    clock.advance(2_000);
    await worker(clock).processDue(1_000);
    expect(await stateOf(refund.transactionId)).toMatchObject({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_PROCESSED' });
  });
});
