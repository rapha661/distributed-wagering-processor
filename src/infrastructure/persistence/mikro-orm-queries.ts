import type { MikroORM } from '@mikro-orm/postgresql';
import type { WageringQueries } from '../../application/ports';
import {
  type LedgerEntryView,
  type ReconciliationSnapshot,
  type TransactionView,
  toLedgerEntryView,
  toTransactionView,
  toWalletView,
  type WalletView,
} from '../../application/views';
import { LedgerEntryEntity, WagerTransactionEntity, WalletEntity } from './entities';
import { toLedgerEntry, toWagerTransaction, toWallet } from './mappers';
import { translatePersistenceError } from './mikro-orm-unit-of-work';

export class MikroOrmWageringQueries implements WageringQueries {
  constructor(private readonly orm: MikroORM) {}

  getWallet(walletId: string): Promise<WalletView | undefined> {
    return this.read(async (em) => {
      const record = await em.findOne(WalletEntity, { id: walletId });
      return record ? toWalletView(toWallet(record)) : undefined;
    });
  }

  getLedger(walletId: string, page: { beforeVersion?: number; limit: number }): Promise<LedgerEntryView[] | undefined> {
    return this.read(async (em) => {
      if ((await em.count(WalletEntity, { id: walletId })) === 0) {
        return undefined;
      }
      const records = await em.find(
        LedgerEntryEntity,
        page.beforeVersion === undefined ? { walletId } : { walletId, walletVersion: { $lt: page.beforeVersion } },
        { orderBy: { walletVersion: 'desc' }, limit: page.limit },
      );
      return records.map((record) => toLedgerEntryView(toLedgerEntry(record)));
    });
  }

  getTransaction(transactionId: string): Promise<TransactionView | undefined> {
    return this.read(async (em) => {
      const record = await em.findOne(WagerTransactionEntity, { id: transactionId });
      return record ? toTransactionView(toWagerTransaction(record)) : undefined;
    });
  }

  getTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView | undefined> {
    return this.read(async (em) => {
      const record = await em.findOne(WagerTransactionEntity, { providerId, externalTransactionId });
      return record ? toTransactionView(toWagerTransaction(record)) : undefined;
    });
  }

  getReconciliationSnapshot(walletId: string): Promise<ReconciliationSnapshot | undefined> {
    return this.read(async (em) => {
      // uma única instrução: saldo e somatório vêm do mesmo snapshot
      const [row] = await em.execute<
        { balance: string; currency: string; credits: string; debits: string; entries: number }[]
      >(
        `select w.balance::text as balance, w.currency,
                coalesce(sum(l.amount) filter (where l.direction = 'CREDIT'), 0)::text as credits,
                coalesce(sum(l.amount) filter (where l.direction = 'DEBIT'), 0)::text as debits,
                count(l.id)::int as entries
           from wallets w
           left join wallet_ledger_entries l on l.wallet_id = w.id
          where w.id = ?
          group by w.id`,
        [walletId],
      );
      return row
        ? {
            walletId,
            currency: row.currency,
            storedBalance: row.balance,
            credits: row.credits,
            debits: row.debits,
            entries: row.entries,
          }
        : undefined;
    });
  }

  private async read<T>(query: (em: MikroORM['em']) => Promise<T>): Promise<T> {
    try {
      return await query(this.orm.em.fork());
    } catch (error) {
      throw translatePersistenceError(error);
    }
  }
}
