import type { EventContext, IntegrationEvent } from '../domain/events/integration-event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../domain/events/wagering-events';
import type { Wallet } from '../domain/wallet/wallet';
import type { SettlementOutcome } from '../domain/wagering/wager-settlement';
import type { WagerTransaction } from '../domain/wagering/wager-transaction';

/**
 * Eventos de integração do resultado de uma liquidação. WalletBalanceChanged só sai quando há
 * lançamento no ledger; a referência pendente é anunciada só na primeira vez.
 */
export function settlementEvents(
  transaction: WagerTransaction,
  wallet: Wallet,
  outcome: SettlementOutcome,
  context: () => EventContext,
  options: { announcePending: boolean },
): IntegrationEvent<unknown>[] {
  switch (outcome.type) {
    case 'processed':
      return outcome.ledgerEntry
        ? [WagerTransactionProcessed.from(transaction, context()), WalletBalanceChanged.from(wallet, outcome.ledgerEntry, context())]
        : [WagerTransactionProcessed.from(transaction, context())];
    case 'rejected':
      return [WagerTransactionRejected.from(transaction, context())];
    case 'pending_reference':
      return options.announcePending ? [WagerTransactionPendingReference.from(transaction, context())] : [];
  }
}
