import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError, Money, type MoneyProps } from '../../../src/domain/money/money';
import { brl, usd } from '../fixtures';

describe('Money', () => {
  it('serializa sempre com 2 casas', () => {
    expect(brl('25.00').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(brl('25').toJSON().amount).toBe('25.00');
    expect(brl('25.5').toJSON().amount).toBe('25.50');
    expect(brl('0.07').toJSON().amount).toBe('0.07');
    expect(Money.zero('BRL').toJSON().amount).toBe('0.00');
  });

  it.each([
    '',
    ' ',
    'NaN',
    'Infinity',
    '-Infinity',
    '1e3',
    '1E3',
    '2.5e-1',
    '10.005',
    '-1.00',
    '+1.00',
    ' 1.00',
    '1,00',
    '01.00',
    '.50',
    '5.',
    '0x10',
    '1234567890123456789.00',
  ])('rejeita o valor %p', (amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  it('rejeita valores que não são string', () => {
    for (const amount of [25, 25.5, null, undefined, {}]) {
      expect(() => Money.from({ amount, currency: 'BRL' } as unknown as MoneyProps)).toThrow(InvalidMoneyError);
    }
  });

  it.each(['brl', 'BR', 'BRLL', '', '123'])('rejeita a moeda %p', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });

  it('não arredonda: mais de 2 casas é erro, não truncamento', () => {
    expect(() => brl('10.005')).toThrow(InvalidMoneyError);
    expect(() => brl('10.999')).toThrow(InvalidMoneyError);
  });

  it('faz aritmética exata', () => {
    expect(brl('0.10').add(brl('0.20')).equals(brl('0.30'))).toBe(true);
    expect(brl('100.00').subtract(brl('80.00')).toJSON().amount).toBe('20.00');
    expect(brl('999999999999999999.99').add(brl('0.01')).toJSON().amount).toBe('1000000000000000000.00');
  });

  it('representa resultados negativos de operações internas', () => {
    const result = brl('20.00').subtract(brl('25.00'));
    expect(result.isNegative()).toBe(true);
    expect(result.toJSON().amount).toBe('-5.00');
    expect(result.negate().toJSON().amount).toBe('5.00');
    expect(brl('0.05').negate().toJSON().amount).toBe('-0.05');
  });

  it('é imutável', () => {
    const original = brl('10.00');
    const sum = original.add(brl('5.00'));
    expect(sum).not.toBe(original);
    expect(original.toJSON().amount).toBe('10.00');
  });

  it('compara valores', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.01').isLessThan(brl('0.02'))).toBe(true);
    expect(brl('0.02').isLessThan(brl('0.02'))).toBe(false);
    expect(brl('1.00').equals(brl('1'))).toBe(true);
    expect(brl('1.00').equals(usd('1.00'))).toBe(false);
  });

  it('lança erro de domínio ao operar moedas diferentes', () => {
    expect(() => brl('1.00').add(usd('1.00'))).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd('1.00'))).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd('1.00'))).toThrow(CurrencyMismatchError);
  });

  it('formata como texto', () => {
    expect(brl('975.00').toString()).toBe('975.00 BRL');
    expect(JSON.stringify({ money: brl('1.50') })).toBe('{"money":{"amount":"1.50","currency":"BRL"}}');
  });
});
