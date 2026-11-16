import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError } from '../../../src/domain/money/money';
import {
  InsufficientFundsError,
  InvalidBalanceMovementError,
  Wallet,
} from '../../../src/domain/wallet/wallet';
import {
  InvalidLedgerEntryError,
  LedgerDirection,
  WalletLedgerEntry,
} from '../../../src/domain/ledger/wallet-ledger-entry';
import { NOW, PLAYER_ID, aWallet, brl, newId, usd } from '../fixtures';

const movement = (amount: string) => ({ transactionId: newId(), entryId: newId(), money: brl(amount), at: NOW });

describe('Wallet', () => {
  it('abre com saldo inicial, versão 1 e lançamento de abertura', () => {
    const opening = { transactionId: newId(), entryId: newId() };
    const { wallet, openingEntry } = Wallet.open({
      id: newId(),
      playerId: PLAYER_ID,
      initialBalance: brl('1000.00'),
      opening,
      at: NOW,
    });

    expect(wallet.balance.toJSON()).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.transactionId).toBe(opening.transactionId);
    expect(openingEntry?.balanceBefore.isZero()).toBe(true);
    expect(openingEntry?.balanceAfter.equals(brl('1000.00'))).toBe(true);
    expect(openingEntry?.walletVersion).toBe(1);
  });

  it('abre com saldo zero sem lançamento', () => {
    const { wallet, openingEntry } = Wallet.open({ id: newId(), playerId: PLAYER_ID, initialBalance: brl('0.00'), at: NOW });
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });

  it('exige a transação de abertura quando o saldo inicial é positivo', () => {
    expect(() => Wallet.open({ id: newId(), playerId: PLAYER_ID, initialBalance: brl('10.00'), at: NOW })).toThrow(
      InvalidBalanceMovementError,
    );
  });

  it('debita, incrementa a versão e devolve o lançamento', () => {
    const wallet = aWallet('100.00');
    const entry = wallet.debit(movement('25.00'));

    expect(wallet.balance.equals(brl('75.00'))).toBe(true);
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.equals(brl('100.00'))).toBe(true);
    expect(entry.balanceAfter.equals(brl('75.00'))).toBe(true);
    expect(entry.walletVersion).toBe(2);
    expect(entry.isBalanced()).toBe(true);
  });

  it('credita e incrementa a versão', () => {
    const wallet = aWallet('100.00');
    const entry = wallet.credit(movement('50.00'));

    expect(wallet.balance.equals(brl('150.00'))).toBe(true);
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  it('permite debitar o saldo inteiro', () => {
    const wallet = aWallet('80.00');
    wallet.debit(movement('80.00'));
    expect(wallet.balance.isZero()).toBe(true);
  });

  it('nunca fica negativa: débito maior que o saldo falha sem alterar nada', () => {
    const wallet = aWallet('100.00');
    expect(() => wallet.debit(movement('100.01'))).toThrow(InsufficientFundsError);
    expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    expect(wallet.version).toBe(1);
    expect(wallet.canDebit(brl('100.01'))).toBe(false);
    expect(wallet.canDebit(brl('100.00'))).toBe(true);
  });

  it('rejeita movimentação em outra moeda', () => {
    const wallet = aWallet('100.00');
    expect(() => wallet.debit({ ...movement('1.00'), money: usd('1.00') })).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit({ ...movement('1.00'), money: usd('1.00') })).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  it('rejeita movimentação de valor zero', () => {
    const wallet = aWallet('100.00');
    expect(() => wallet.credit(movement('0.00'))).toThrow(InvalidBalanceMovementError);
    expect(wallet.version).toBe(1);
  });

  it('versão só muda quando o saldo muda', () => {
    const wallet = aWallet('100.00');
    wallet.debit(movement('10.00'));
    wallet.credit(movement('5.00'));
    expect(() => wallet.debit(movement('500.00'))).toThrow(InsufficientFundsError);
    expect(wallet.version).toBe(3);
  });

  it('reidrata o estado persistido sem revalidar', () => {
    const wallet = Wallet.rehydrate({
      id: 'w-1',
      playerId: PLAYER_ID,
      currency: 'BRL',
      balance: brl('42.00'),
      version: 17,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(wallet.version).toBe(17);
    expect(wallet.balance.equals(brl('42.00'))).toBe(true);
  });
});

describe('WalletLedgerEntry', () => {
  const base = {
    id: 'e-1',
    walletId: 'w-1',
    transactionId: 't-1',
    direction: LedgerDirection.Debit,
    money: brl('30.00'),
    balanceBefore: brl('100.00'),
    balanceAfter: brl('70.00'),
    walletVersion: 2,
    createdAt: NOW,
  };

  it('valida a aritmética na criação', () => {
    expect(WalletLedgerEntry.create(base).isBalanced()).toBe(true);
    expect(() => WalletLedgerEntry.create({ ...base, balanceAfter: brl('71.00') })).toThrow(InvalidLedgerEntryError);
    expect(() => WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit })).toThrow(
      InvalidLedgerEntryError,
    );
  });

  it('rejeita valor zero e saldos negativos', () => {
    expect(() => WalletLedgerEntry.create({ ...base, money: brl('0.00'), balanceAfter: brl('100.00') })).toThrow(
      InvalidLedgerEntryError,
    );
    expect(() =>
      WalletLedgerEntry.create({ ...base, balanceBefore: brl('10.00'), balanceAfter: brl('10.00').subtract(brl('30.00')) }),
    ).toThrow(InvalidLedgerEntryError);
  });

  it('rejeita moedas misturadas', () => {
    expect(() => WalletLedgerEntry.create({ ...base, money: usd('30.00') })).toThrow(InvalidLedgerEntryError);
  });

  it('é estruturalmente imutável', () => {
    const entry = WalletLedgerEntry.create(base);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { balanceAfter: unknown }).balanceAfter = brl('1000.00');
    }).toThrow(TypeError);
  });

  it('expõe o efeito com sinal no saldo', () => {
    expect(WalletLedgerEntry.create(base).signedAmount().toJSON().amount).toBe('-30.00');
  });
});
