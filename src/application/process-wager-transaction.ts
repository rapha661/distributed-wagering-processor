import { Money, type MoneyProps } from '../domain/money/money';
import { OutboxMessage } from '../domain/messaging/outbox-message';
import type { IntegrationEvent } from '../domain/events/integration-event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../domain/events/wagering-events';
import type { BackoffPolicy } from '../domain/shared/backoff-policy';
import type { Wallet } from '../domain/wallet/wallet';
import { WagerSettlement, type SettlementOutcome } from '../domain/wagering/wager-settlement';
import { WagerTransaction } from '../domain/wagering/wager-transaction';
import type { FailureCode, WagerTransactionKind, WagerTransactionStatus } from '../domain/wagering/wager-types';
import {
  DuplicateKeyError,
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  WalletNotFoundError,
} from './errors';
import type { Clock, IdGenerator, UnitOfWork } from './ports';

export interface WagerRequestInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

export interface SubmitWagerCommand {
  idempotencyKey: string;
  request: WagerRequestInput;
  correlationId: string;
  causationId?: string | undefined;
}

export interface WagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps | null;
  failureCode: FailureCode | null;
  idempotentReplay: boolean;
}

/**
 * Caso de uso único de submissão de transação, usado pela API HTTP e pelo consumidor SQS.
 *
 * Concorrência: a wallet é travada com SELECT ... FOR UPDATE antes de qualquer decisão, então
 * tudo o que depende dela (saldo, referência, "reverter uma vez") fica serializado por wallet.
 * A unicidade da idempotency key é garantida pelo banco; se duas instâncias correrem na mesma
 * key, a perdedora recebe violação de unique, tenta de novo e cai no replay.
 */
export class ProcessWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly referenceRetry: BackoffPolicy,
  ) {}

  async execute(command: SubmitWagerCommand): Promise<WagerResult> {
    try {
      return await this.attempt(command);
    } catch (error) {
      if (error instanceof DuplicateKeyError) {
        return this.attempt(command);
      }
      throw error;
    }
  }

  private attempt(command: SubmitWagerCommand): Promise<WagerResult> {
    const candidate = WagerTransaction.create({
      ...command.request,
      money: Money.from(command.request.money),
      id: this.ids.next(),
      idempotencyKey: command.idempotencyKey,
      createdAt: this.clock.now(),
    });

    return this.uow.run(async ({ wallets, transactions, ledger, outbox }) => {
      // replay não precisa do lock
      const existing = await transactions.findByIdempotencyKey(command.idempotencyKey);
      if (existing) {
        return replay(existing, candidate);
      }

      const wallet = await wallets.lockById(candidate.walletId);
      if (!wallet) {
        throw new WalletNotFoundError(candidate.walletId);
      }
      // com o lock, enxergamos o que a instância anterior commitou para esta wallet
      const settled = await transactions.findByIdempotencyKey(command.idempotencyKey);
      if (settled) {
        return replay(settled, candidate);
      }
      if (await transactions.findByExternalId(candidate.providerId, candidate.externalTransactionId)) {
        throw new ExternalTransactionConflictError(candidate.providerId, candidate.externalTransactionId);
      }

      const reference =
        candidate.referenceExternalTransactionId === undefined
          ? undefined
          : await transactions.findByExternalId(candidate.providerId, candidate.referenceExternalTransactionId);
      const now = this.clock.now();
      const outcome = WagerSettlement.settle(candidate, {
        wallet,
        reference,
        referenceAlreadyReversed: reference ? await transactions.hasProcessedReversal(reference.id) : false,
        ledgerEntryId: this.ids.next(),
        referenceRetry: this.referenceRetry,
        at: now,
      });

      transactions.add(candidate);
      if (outcome.type === 'processed' && outcome.ledgerEntry) {
        wallets.update(wallet);
        ledger.add(outcome.ledgerEntry);
      }
      for (const event of this.eventsFor(candidate, wallet, outcome, command, now)) {
        outbox.add(OutboxMessage.enqueue(event));
      }
      return toResult(candidate, false);
    });
  }

  private eventsFor(
    transaction: WagerTransaction,
    wallet: Wallet,
    outcome: SettlementOutcome,
    command: SubmitWagerCommand,
    now: Date,
  ): IntegrationEvent<unknown>[] {
    const ctx = () => ({
      eventId: this.ids.next(),
      correlationId: command.correlationId,
      causationId: command.causationId,
      occurredAt: now,
    });
    switch (outcome.type) {
      case 'processed':
        return outcome.ledgerEntry
          ? [WagerTransactionProcessed.from(transaction, ctx()), WalletBalanceChanged.from(wallet, outcome.ledgerEntry, ctx())]
          : [WagerTransactionProcessed.from(transaction, ctx())];
      case 'rejected':
        return [WagerTransactionRejected.from(transaction, ctx())];
      case 'pending_reference':
        return [WagerTransactionPendingReference.from(transaction, ctx())];
    }
  }
}

function replay(existing: WagerTransaction, candidate: WagerTransaction): WagerResult {
  if (!existing.matchesPayload(candidate.payloadHash)) {
    throw new IdempotencyConflictError(existing.idempotencyKey);
  }
  return toResult(existing, true);
}

function toResult(transaction: WagerTransaction, idempotentReplay: boolean): WagerResult {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    balance: transaction.observedBalance?.toJSON() ?? null,
    failureCode: transaction.failureCode ?? null,
    idempotentReplay,
  };
}
