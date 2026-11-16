import { CurrencyMismatchError, Money } from '../money/money';
import { LedgerDirection, WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import { DomainError } from '../shared/errors';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  /** Obrigatório quando o saldo inicial é positivo: identifica a transação OPENING e seu lançamento. */
  opening?: { transactionId: string; entryId: string };
  at: Date;
}

export interface WalletOpening {
  wallet: Wallet;
  openingEntry: WalletLedgerEntry | undefined;
}

export interface BalanceMovement {
  transactionId: string;
  entryId: string;
  money: Money;
  at: Date;
}

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';
}

export class InvalidBalanceMovementError extends DomainError {
  readonly code = 'INVALID_BALANCE_MOVEMENT';
}

/**
 * Aggregate root do saldo. Toda mudança de saldo passa por `debit`/`credit`,
 * que devolvem o lançamento do ledger correspondente e incrementam a versão.
 */
export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private _balance: Money,
    private _version: number,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): WalletOpening {
    const { initialBalance, at } = props;
    if (initialBalance.isNegative()) {
      throw new InvalidBalanceMovementError('initial balance cannot be negative');
    }

    const wallet = new Wallet(props.id, props.playerId, initialBalance.currency, initialBalance, 1, at, at);
    if (initialBalance.isZero()) {
      return { wallet, openingEntry: undefined };
    }
    if (!props.opening) {
      throw new InvalidBalanceMovementError('a positive initial balance requires an opening transaction');
    }

    const openingEntry = WalletLedgerEntry.create({
      id: props.opening.entryId,
      walletId: wallet.id,
      transactionId: props.opening.transactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: initialBalance,
      walletVersion: wallet.version,
      createdAt: at,
    });
    return { wallet, openingEntry };
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(movement: BalanceMovement): WalletLedgerEntry {
    this.assertValidMovement(movement.money);
    if (this._balance.isLessThan(movement.money)) {
      throw new InsufficientFundsError(`wallet ${this.id} has insufficient funds`);
    }
    return this.apply(LedgerDirection.Debit, movement);
  }

  credit(movement: BalanceMovement): WalletLedgerEntry {
    this.assertValidMovement(movement.money);
    return this.apply(LedgerDirection.Credit, movement);
  }

  private apply(direction: LedgerDirection, movement: BalanceMovement): WalletLedgerEntry {
    const balanceBefore = this._balance;
    const balanceAfter =
      direction === LedgerDirection.Credit
        ? balanceBefore.add(movement.money)
        : balanceBefore.subtract(movement.money);

    // o lançamento é criado antes de mexer no estado: se ele falhar, a wallet fica intacta
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore,
      balanceAfter,
      walletVersion: this._version + 1,
      createdAt: movement.at,
    });

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = movement.at;
    return entry;
  }

  private assertValidMovement(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvalidBalanceMovementError('movement amount must be positive');
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
