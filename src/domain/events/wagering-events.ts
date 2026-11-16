import type { MoneyProps } from '../money/money';
import type { LedgerDirection, WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import { InvalidStateError } from '../shared/errors';
import type { Wallet } from '../wallet/wallet';
import type { WagerTransaction } from '../wagering/wager-transaction';
import { type FailureCode, type WagerTransactionKind, WagerTransactionStatus } from '../wagering/wager-types';
import { type EventContext, IntegrationEvent } from './integration-event';

interface TransactionData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
}

function transactionData(transaction: WagerTransaction): TransactionData {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
  };
}

function assertStatus(transaction: WagerTransaction, expected: WagerTransactionStatus): void {
  if (transaction.status !== expected) {
    throw new InvalidStateError(`transaction ${transaction.id} is ${transaction.status}, expected ${expected}`);
  }
}

export interface WagerTransactionProcessedData extends TransactionData {
  referenceTransactionId: string | null;
  balance: MoneyProps;
  processedAt: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    assertStatus(transaction, WagerTransactionStatus.Processed);
    const { processedAt, observedBalance } = transaction;
    if (!processedAt || !observedBalance) {
      throw new InvalidStateError(`processed transaction ${transaction.id} without outcome`);
    }
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: transaction.id,
      data: {
        ...transactionData(transaction),
        referenceTransactionId: transaction.referenceTransactionId ?? null,
        balance: observedBalance.toJSON(),
        processedAt: processedAt.toISOString(),
      },
    });
  }
}

export interface WagerTransactionRejectedData extends TransactionData {
  failureCode: FailureCode;
  balance: MoneyProps | null;
  rejectedAt: string;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    assertStatus(transaction, WagerTransactionStatus.Rejected);
    if (!transaction.failureCode) {
      throw new InvalidStateError(`rejected transaction ${transaction.id} without failure code`);
    }
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: transaction.id,
      data: {
        ...transactionData(transaction),
        failureCode: transaction.failureCode,
        balance: transaction.observedBalance?.toJSON() ?? null,
        rejectedAt: transaction.updatedAt.toISOString(),
      },
    });
  }
}

export interface WagerTransactionPendingReferenceData extends TransactionData {
  referenceExternalTransactionId: string;
  attempts: number;
  nextAttemptAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    assertStatus(transaction, WagerTransactionStatus.PendingReference);
    const { referenceExternalTransactionId, nextReferenceAttemptAt } = transaction;
    if (referenceExternalTransactionId === undefined || !nextReferenceAttemptAt) {
      throw new InvalidStateError(`pending transaction ${transaction.id} without reference`);
    }
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: transaction.id,
      data: {
        ...transactionData(transaction),
        referenceExternalTransactionId,
        attempts: transaction.referenceAttempts,
        nextAttemptAt: nextReferenceAttemptAt.toISOString(),
      },
    });
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    if (entry.walletId !== wallet.id) {
      throw new InvalidStateError(`ledger entry ${entry.id} does not belong to wallet ${wallet.id}`);
    }
    return new WalletBalanceChanged({
      ...ctx,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      },
    });
  }
}
