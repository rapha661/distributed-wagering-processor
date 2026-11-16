import { OutboxMessage } from '../domain/messaging/outbox-message';
import type { BackoffPolicy } from '../domain/shared/backoff-policy';
import { InvalidStateError } from '../domain/shared/errors';
import { WagerSettlement } from '../domain/wagering/wager-settlement';
import type { WagerTransactionStatus } from '../domain/wagering/wager-types';
import type { Clock, IdGenerator, UnitOfWork } from './ports';
import { settlementEvents } from './settlement-events';

export interface ReprocessResult {
  transactionId: string;
  status: WagerTransactionStatus;
}

/**
 * Reprocessa transações PENDING_REFERENCE vencidas. Cada uma é tratada numa transação própria:
 * trava a transação (SKIP LOCKED, para workers concorrentes não pegarem a mesma), trava a wallet
 * e liquida de novo com as mesmas regras da submissão. Sem referência, reagenda com backoff;
 * esgotadas as tentativas, rejeita com REFERENCE_NOT_FOUND.
 */
export class ReprocessPendingReferences {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly referenceRetry: BackoffPolicy,
  ) {}

  /** Processa até `limit` transações vencidas e devolve o que aconteceu com cada uma. */
  async processDue(limit: number): Promise<ReprocessResult[]> {
    const results: ReprocessResult[] = [];
    while (results.length < limit) {
      const result = await this.processNext();
      if (!result) {
        break;
      }
      results.push(result);
    }
    return results;
  }

  processNext(): Promise<ReprocessResult | undefined> {
    return this.uow.run(async ({ wallets, transactions, ledger, outbox }) => {
      const now = this.clock.now();
      const transaction = await transactions.lockNextDuePendingReference(now);
      if (!transaction) {
        return undefined;
      }
      const wallet = await wallets.lockById(transaction.walletId);
      const referenceId = transaction.referenceExternalTransactionId;
      if (!wallet || referenceId === undefined) {
        throw new InvalidStateError(`pending transaction ${transaction.id} without wallet or reference`);
      }

      const reference = await transactions.findByExternalId(transaction.providerId, referenceId);
      const outcome = WagerSettlement.settle(transaction, {
        wallet,
        reference,
        referenceAlreadyReversed: reference ? await transactions.hasProcessedReversal(reference.id) : false,
        ledgerEntryId: this.ids.next(),
        referenceRetry: this.referenceRetry,
        at: now,
      });

      transactions.update(transaction);
      if (outcome.type === 'processed' && outcome.ledgerEntry) {
        wallets.update(wallet);
        ledger.add(outcome.ledgerEntry);
      }
      // sem request de origem: a própria transação correlaciona os eventos do reprocessamento
      const context = () => ({ eventId: this.ids.next(), correlationId: transaction.id, causationId: transaction.id, occurredAt: now });
      for (const event of settlementEvents(transaction, wallet, outcome, context, { announcePending: false })) {
        outbox.add(OutboxMessage.enqueue(event));
      }
      return { transactionId: transaction.id, status: transaction.status };
    });
  }
}
