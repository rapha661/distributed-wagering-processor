import { DomainError } from '../shared/errors';

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(expected: string, received: string) {
    super(`currency mismatch: expected ${expected}, received ${received}`);
  }
}

// Até 18 dígitos inteiros e 2 casas, sem sinal: cabe em NUMERIC(20,2).
const AMOUNT = /^(?<units>0|[1-9]\d{0,17})(?:\.(?<cents>\d{1,2}))?$/;
const CURRENCY = /^[A-Z]{3}$/;
const SCALE = 2;
const CENTS_PER_UNIT = 100n;

/**
 * Valor monetário imutável com escala fixa de 2 casas.
 * Internamente guarda centavos em bigint: nenhuma operação passa por ponto flutuante.
 */
export class Money {
  private constructor(
    private readonly cents: bigint,
    readonly currency: string,
  ) {}

  /** Contrato de entrada: string decimal não negativa com até 2 casas. Nunca arredonda. */
  static from(props: MoneyProps): Money {
    const currency = Money.parseCurrency(props?.currency);
    const amount: unknown = props?.amount;
    const match = typeof amount === 'string' ? AMOUNT.exec(amount) : null;
    if (!match?.groups) {
      throw new InvalidMoneyError(`invalid amount: ${String(amount)}`);
    }
    const units = BigInt(match.groups.units ?? '0');
    const cents = BigInt((match.groups.cents ?? '').padEnd(SCALE, '0'));
    return new Money(units * CENTS_PER_UNIT + cents, currency);
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.parseCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    return new Money(-this.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  isPositive(): boolean {
    return this.cents > 0n;
  }

  isNegative(): boolean {
    return this.cents < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.cents === other.cents;
  }

  toJSON(): MoneyProps {
    const negative = this.cents < 0n;
    const absolute = negative ? -this.cents : this.cents;
    const units = absolute / CENTS_PER_UNIT;
    const cents = (absolute % CENTS_PER_UNIT).toString().padStart(SCALE, '0');
    return { amount: `${negative ? '-' : ''}${units}.${cents}`, currency: this.currency };
  }

  toString(): string {
    const { amount, currency } = this.toJSON();
    return `${amount} ${currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static parseCurrency(value: unknown): string {
    if (typeof value !== 'string' || !CURRENCY.test(value)) {
      throw new InvalidMoneyError(`invalid currency: ${String(value)}`);
    }
    return value;
  }
}
