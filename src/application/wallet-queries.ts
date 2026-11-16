import { Money, type MoneyProps } from '../domain/money/money';
import {
  InvalidRequestError,
  TransactionNotFoundError,
  WalletNotFoundError,
} from './errors';
import type { ReconciliationObserver, WageringQueries } from './ports';
import type { LedgerEntryView, TransactionView, WalletView } from './views';

export const MAX_LEDGER_PAGE = 200;

export interface LedgerPage {
  items: LedgerEntryView[];
  nextCursor: string | null;
}

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

export class WalletQueries {
  constructor(
    private readonly queries: WageringQueries,
    private readonly observer: ReconciliationObserver,
  ) {}

  async getWallet(walletId: string): Promise<WalletView> {
    const wallet = await this.queries.getWallet(walletId);
    if (!wallet) {
      throw new WalletNotFoundError(walletId);
    }
    return wallet;
  }

  /** Página do ledger, do lançamento mais novo para o mais antigo. O cursor é estável: aponta para uma versão da wallet. */
  async getLedger(walletId: string, options: { cursor?: string | undefined; limit: number }): Promise<LedgerPage> {
    const limit = Math.min(Math.max(1, options.limit), MAX_LEDGER_PAGE);
    const beforeVersion = options.cursor === undefined ? undefined : decodeCursor(options.cursor);
    const entries = await this.queries.getLedger(walletId, { beforeVersion, limit: limit + 1 });
    if (!entries) {
      throw new WalletNotFoundError(walletId);
    }
    const items = entries.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: entries.length > limit && last ? encodeCursor(last.walletVersion) : null,
    };
  }

  async getTransaction(transactionId: string): Promise<TransactionView> {
    const transaction = await this.queries.getTransaction(transactionId);
    if (!transaction) {
      throw new TransactionNotFoundError(transactionId);
    }
    return transaction;
  }

  async getTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView> {
    const transaction = await this.queries.getTransactionByExternalId(providerId, externalTransactionId);
    if (!transaction) {
      throw new TransactionNotFoundError(`${providerId}:${externalTransactionId}`);
    }
    return transaction;
  }

  /**
   * Compara o saldo materializado com o saldo reconstruído pelo ledger.
   * Divergência é reportada ao observer e na resposta; nunca é corrigida aqui.
   */
  async reconcile(walletId: string): Promise<ReconciliationReport> {
    const snapshot = await this.queries.getReconciliationSnapshot(walletId);
    if (!snapshot) {
      throw new WalletNotFoundError(walletId);
    }
    const money = (amount: string) => Money.from({ amount, currency: snapshot.currency });
    const stored = money(snapshot.storedBalance);
    const calculated = money(snapshot.credits).subtract(money(snapshot.debits));
    const difference = stored.subtract(calculated);

    const report: ReconciliationReport = {
      walletId,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent: difference.isZero(),
      checkedEntries: snapshot.entries,
    };
    if (!report.consistent) {
      this.observer.mismatch({ walletId, difference: difference.toString(), checkedEntries: snapshot.entries });
    }
    return report;
  }
}

function encodeCursor(walletVersion: number): string {
  return Buffer.from(`v1:${walletVersion}`).toString('base64url');
}

function decodeCursor(cursor: string): number {
  const match = /^v1:(\d{1,10})$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  const version = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new InvalidRequestError('INVALID_CURSOR', 'cursor is invalid');
  }
  return version;
}
