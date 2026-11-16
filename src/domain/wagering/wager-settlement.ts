import { LedgerDirection, type WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import type { BackoffPolicy } from '../shared/backoff-policy';
import { InvalidStateError } from '../shared/errors';
import type { Wallet } from '../wallet/wallet';
import { InvalidTransactionStateError, type WagerTransaction } from './wager-transaction';
import { FailureCode, WagerTransactionStatus } from './wager-types';

export interface SettlementContext {
  /** Wallet da transação, já travada pelo chamador. */
  wallet: Wallet;
  /** Resultado da busca por (providerId, referenceExternalTransactionId); undefined se não existe. */
  reference: WagerTransaction | undefined;
  /** Se a referência já foi revertida por um REFUND ou ROLLBACK processado. */
  referenceAlreadyReversed: boolean;
  ledgerEntryId: string;
  referenceRetry: BackoffPolicy;
  at: Date;
}

export type SettlementOutcome =
  | { type: 'processed'; ledgerEntry: WalletLedgerEntry | undefined; reference: WagerTransaction | undefined }
  | { type: 'rejected'; failureCode: FailureCode }
  | { type: 'pending_reference' };

type ReferenceCheck =
  | { type: 'resolved'; reference: WagerTransaction | undefined }
  | { type: 'waiting' }
  | { type: 'invalid'; failureCode: FailureCode };

/**
 * Aplica uma transação à wallet seguindo as regras de BET, WIN, LOSS, REFUND e ROLLBACK.
 * Muda o estado da transação e da wallet em memória; persistir é com o chamador.
 */
export class WagerSettlement {
  static settle(transaction: WagerTransaction, ctx: SettlementContext): SettlementOutcome {
    const { wallet, at } = ctx;
    if (transaction.isTerminal()) {
      throw new InvalidTransactionStateError(`transaction ${transaction.id} is already ${transaction.status}`);
    }
    if (transaction.walletId !== wallet.id) {
      throw new InvalidStateError(`transaction ${transaction.id} does not belong to wallet ${wallet.id}`);
    }

    if (transaction.playerId !== wallet.playerId) {
      return WagerSettlement.reject(transaction, FailureCode.PlayerWalletMismatch, ctx);
    }
    if (transaction.money.currency !== wallet.currency) {
      return WagerSettlement.reject(transaction, FailureCode.CurrencyMismatch, ctx);
    }

    const check = WagerSettlement.checkReference(transaction, ctx);
    if (check.type === 'invalid') {
      return WagerSettlement.reject(transaction, check.failureCode, ctx);
    }
    if (check.type === 'waiting') {
      if (ctx.referenceRetry.isExhausted(transaction.referenceAttempts)) {
        return WagerSettlement.reject(transaction, FailureCode.ReferenceNotFound, ctx);
      }
      transaction.markPendingReference(at, wallet.balance, ctx.referenceRetry);
      return { type: 'pending_reference' };
    }

    const { reference } = check;
    if (!transaction.affectsBalance()) {
      transaction.markProcessed(reference?.id, at, wallet.balance);
      return { type: 'processed', ledgerEntry: undefined, reference };
    }

    const movement = {
      transactionId: transaction.id,
      entryId: ctx.ledgerEntryId,
      money: transaction.money,
      at,
    };
    let ledgerEntry: WalletLedgerEntry;
    if (transaction.ledgerDirectionFor(reference) === LedgerDirection.Debit) {
      if (!wallet.canDebit(transaction.money)) {
        const code = transaction.isReversal()
          ? FailureCode.ReversalInsufficientFunds
          : FailureCode.InsufficientFunds;
        return WagerSettlement.reject(transaction, code, ctx);
      }
      ledgerEntry = wallet.debit(movement);
    } else {
      ledgerEntry = wallet.credit(movement);
    }

    transaction.markProcessed(reference?.id, at, wallet.balance);
    return { type: 'processed', ledgerEntry, reference };
  }

  private static checkReference(transaction: WagerTransaction, ctx: SettlementContext): ReferenceCheck {
    if (transaction.referenceExternalTransactionId === undefined) {
      return { type: 'resolved', reference: undefined };
    }

    const reference = ctx.reference;
    if (
      !reference ||
      reference.status === WagerTransactionStatus.Pending ||
      reference.status === WagerTransactionStatus.PendingReference
    ) {
      return { type: 'waiting' };
    }

    const sameContext =
      reference.providerId === transaction.providerId &&
      reference.playerId === transaction.playerId &&
      reference.walletId === transaction.walletId &&
      reference.roundId === transaction.roundId &&
      reference.money.currency === transaction.money.currency;
    if (!sameContext) {
      return { type: 'invalid', failureCode: FailureCode.ReferenceMismatch };
    }
    if (!transaction.canReference(reference.kind)) {
      return { type: 'invalid', failureCode: FailureCode.InvalidReferenceKind };
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      return { type: 'invalid', failureCode: FailureCode.ReferenceNotProcessed };
    }
    if (ctx.referenceAlreadyReversed) {
      return { type: 'invalid', failureCode: FailureCode.ReferenceAlreadyReversed };
    }
    if (transaction.isReversal() && !reference.money.equals(transaction.money)) {
      return { type: 'invalid', failureCode: FailureCode.ReversalAmountMismatch };
    }
    return { type: 'resolved', reference };
  }

  private static reject(
    transaction: WagerTransaction,
    code: FailureCode,
    ctx: SettlementContext,
  ): SettlementOutcome {
    transaction.reject(code, ctx.at, ctx.wallet.balance);
    return { type: 'rejected', failureCode: code };
  }
}
