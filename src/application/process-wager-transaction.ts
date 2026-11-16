import { Money, type MoneyProps } from '../domain/money/money';
import { InboxMessage, type ReceiveInboxProps } from '../domain/messaging/inbox-message';
import { OutboxMessage } from '../domain/messaging/outbox-message';
import type { BackoffPolicy } from '../domain/shared/backoff-policy';
import { WagerSettlement } from '../domain/wagering/wager-settlement';
import { WagerTransaction } from '../domain/wagering/wager-transaction';
import type { FailureCode, WagerTransactionKind, WagerTransactionStatus } from '../domain/wagering/wager-types';
import {
  DuplicateKeyError,
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  MessageConflictError,
  WalletNotFoundError,
} from './errors';
import type { Clock, IdGenerator, UnitOfWork } from './ports';
import { settlementEvents } from './settlement-events';

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

  /**
   * `delivery` vem do consumidor da fila: a mensagem entra no inbox na mesma transação do
   * resultado, e uma redelivery cai no replay sem efeito novo.
   */
  async execute(command: SubmitWagerCommand, delivery?: ReceiveInboxProps): Promise<WagerResult> {
    try {
      return await this.attempt(command, delivery);
    } catch (error) {
      if (error instanceof DuplicateKeyError) {
        return this.attempt(command, delivery);
      }
      throw error;
    }
  }

  private candidate(command: SubmitWagerCommand): WagerTransaction {
    return WagerTransaction.create({
      ...command.request,
      money: Money.from(command.request.money),
      id: this.ids.next(),
      idempotencyKey: command.idempotencyKey,
      createdAt: this.clock.now(),
    });
  }

  private attempt(command: SubmitWagerCommand, delivery: ReceiveInboxProps | undefined): Promise<WagerResult> {
    const candidate = this.candidate(command);

    return this.uow.run(async ({ wallets, transactions, ledger, inbox, outbox }) => {
      const consumed = delivery && (await inbox.find(delivery.consumerName, delivery.messageId));
      if (delivery && consumed && !consumed.matchesPayload(delivery.payloadHash)) {
        throw new MessageConflictError(delivery.messageId);
      }
      const done = (result: WagerResult) => {
        if (delivery && !consumed) {
          const message = InboxMessage.receive(delivery);
          message.markProcessed(this.clock.now());
          inbox.add(message);
        }
        return result;
      };

      // replay (inclusive de mensagem já consumida) não precisa do lock
      const existing = await transactions.findByIdempotencyKey(command.idempotencyKey);
      if (existing) {
        return done(replay(existing, candidate));
      }

      const wallet = await wallets.lockById(candidate.walletId);
      if (!wallet) {
        throw new WalletNotFoundError(candidate.walletId);
      }
      // com o lock, enxergamos o que a instância anterior commitou para esta wallet
      const settled = await transactions.findByIdempotencyKey(command.idempotencyKey);
      if (settled) {
        return done(replay(settled, candidate));
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
      const context = () => ({
        eventId: this.ids.next(),
        correlationId: command.correlationId,
        causationId: command.causationId,
        occurredAt: now,
      });
      for (const event of settlementEvents(candidate, wallet, outcome, context, { announcePending: true })) {
        outbox.add(OutboxMessage.enqueue(event));
      }
      return done(toResult(candidate, false));
    });
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
