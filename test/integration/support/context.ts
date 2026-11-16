import { expect } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { CreateWallet } from '../../../src/application/create-wallet';
import { ProcessWagerTransaction, type SubmitWagerCommand } from '../../../src/application/process-wager-transaction';
import type { UnitOfWork } from '../../../src/application/ports';
import { WalletQueries } from '../../../src/application/wallet-queries';
import { BackoffPolicy } from '../../../src/domain/shared/backoff-policy';
import { WagerTransactionKind } from '../../../src/domain/wagering/wager-types';
import { MikroOrmWageringQueries } from '../../../src/infrastructure/persistence/mikro-orm-queries';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { systemClock, uuidV7Generator } from '../../../src/infrastructure/system';
import { connectTestDatabase } from './database';

export interface TestContext {
  orm: MikroORM;
  uow: UnitOfWork;
  createWallet: CreateWallet;
  process: ProcessWagerTransaction;
  queries: WalletQueries;
  mismatches: { walletId: string; difference: string }[];
  close(): Promise<void>;
}

export async function createTestContext(options: { lockTimeoutMs?: number; uow?: (base: UnitOfWork) => UnitOfWork } = {}): Promise<TestContext> {
  const orm = await connectTestDatabase();
  const base = new MikroOrmUnitOfWork(orm, options.lockTimeoutMs ?? 5_000);
  const uow = options.uow ? options.uow(base) : base;
  const mismatches: TestContext['mismatches'] = [];
  return {
    orm,
    uow,
    createWallet: new CreateWallet(uow, systemClock, uuidV7Generator),
    process: new ProcessWagerTransaction(uow, systemClock, uuidV7Generator, new BackoffPolicy(2_000, 300_000, 8)),
    queries: new WalletQueries(new MikroOrmWageringQueries(orm), { mismatch: (report) => mismatches.push(report) }),
    mismatches,
    close: () => orm.close(),
  };
}

export async function openWallet(ctx: TestContext, amount = '100.00', currency = 'BRL') {
  return ctx.createWallet.execute({
    playerId: crypto.randomUUID(),
    initialBalance: { amount, currency },
    correlationId: 'test',
  });
}

export function wager(
  wallet: { id: string; playerId: string },
  kind: WagerTransactionKind,
  amount: string,
  overrides: Partial<SubmitWagerCommand['request']> & { idempotencyKey?: string } = {},
): SubmitWagerCommand {
  const { idempotencyKey, ...request } = overrides;
  const externalTransactionId = request.externalTransactionId ?? `tx-${crypto.randomUUID()}`;
  return {
    idempotencyKey: idempotencyKey ?? `provider-a:${externalTransactionId}`,
    correlationId: 'test',
    request: {
      providerId: 'provider-a',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind,
      money: { amount, currency: 'BRL' },
      ...request,
    },
  };
}

export const bet = (wallet: { id: string; playerId: string }, amount: string, overrides = {}) =>
  wager(wallet, WagerTransactionKind.Bet, amount, overrides);

type Row = Record<string, unknown>;

export async function sql<T extends Row = Row>(ctx: TestContext, query: string, params: unknown[] = []): Promise<T[]> {
  return ctx.orm.em.getConnection().execute<T[]>(query, params);
}

/**
 * Invariante final de todos os testes: o saldo materializado é igual ao saldo
 * reconstruído pelo ledger, e a cadeia de versões não tem buracos nem repetições.
 */
export async function expectConsistent(ctx: TestContext, walletId: string): Promise<void> {
  const report = await ctx.queries.reconcile(walletId);
  expect(report.consistent).toBe(true);

  const [chain] = await sql<{ version: number; entries: number; min: number | null; max: number | null; last: string | null; balance: string }>(
    ctx,
    `select w.version, w.balance::text as balance, count(l.id)::int as entries,
            min(l.wallet_version) as min, max(l.wallet_version) as max,
            (select balance_after::text from wallet_ledger_entries
              where wallet_id = w.id order by wallet_version desc limit 1) as last
       from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
      where w.id = ? group by w.id`,
    [walletId],
  );
  if (chain && chain.entries > 0) {
    expect(chain.max).toBe(chain.version);
    expect(chain.entries).toBe((chain.max ?? 0) - (chain.min ?? 0) + 1);
    expect(chain.last).toBe(chain.balance);
  }
}
