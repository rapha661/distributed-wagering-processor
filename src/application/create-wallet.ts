import { Money, type MoneyProps } from '../domain/money/money';
import { OutboxMessage } from '../domain/messaging/outbox-message';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../domain/events/wagering-events';
import { Wallet } from '../domain/wallet/wallet';
import { WagerTransaction } from '../domain/wagering/wager-transaction';
import { DuplicateKeyError, WalletAlreadyExistsError } from './errors';
import type { Clock, IdGenerator, UnitOfWork } from './ports';
import { toWalletView, type WalletView } from './views';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

/** Abre a wallet. Um saldo inicial positivo vira uma transação OPENING com lançamento CREDIT, na mesma transação SQL. */
export class CreateWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: CreateWalletCommand): Promise<WalletView> {
    const initialBalance = Money.from(command.initialBalance);
    const at = this.clock.now();
    const walletId = this.ids.next();
    const opening = initialBalance.isPositive()
      ? WagerTransaction.opening({ id: this.ids.next(), walletId, playerId: command.playerId, money: initialBalance, at })
      : undefined;
    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: command.playerId,
      initialBalance,
      opening: opening && { transactionId: opening.id, entryId: this.ids.next() },
      at,
    });

    try {
      await this.uow.run(async ({ wallets, transactions, ledger, outbox }) => {
        wallets.add(wallet);
        if (opening && openingEntry) {
          transactions.add(opening);
          ledger.add(openingEntry);
          const ctx = () => ({ eventId: this.ids.next(), correlationId: command.correlationId, occurredAt: at });
          outbox.add(OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, ctx())));
          outbox.add(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, ctx())));
        }
      });
    } catch (error) {
      if (error instanceof DuplicateKeyError && error.key === 'wallet-player-currency') {
        throw new WalletAlreadyExistsError(command.playerId, initialBalance.currency);
      }
      throw error;
    }
    return toWalletView(wallet);
  }
}
