import { describe, expect, it } from 'bun:test';
import { WagerSettlement, type SettlementContext } from '../../../src/domain/wagering/wager-settlement';
import type { WagerTransaction } from '../../../src/domain/wagering/wager-transaction';
import { InvalidTransactionStateError } from '../../../src/domain/wagering/wager-transaction';
import { FailureCode, WagerTransactionKind, WagerTransactionStatus } from '../../../src/domain/wagering/wager-types';
import { LedgerDirection } from '../../../src/domain/ledger/wallet-ledger-entry';
import type { Wallet } from '../../../src/domain/wallet/wallet';
import { NOW, aTransaction, aWallet, brl, newId, referenceRetry, usd } from '../fixtures';

const { Bet, Win, Loss, Refund, Rollback } = WagerTransactionKind;

function settle(
  transaction: WagerTransaction,
  wallet: Wallet,
  options: Partial<Pick<SettlementContext, 'reference' | 'referenceAlreadyReversed'>> = {},
) {
  return WagerSettlement.settle(transaction, {
    wallet,
    reference: options.reference,
    referenceAlreadyReversed: options.referenceAlreadyReversed ?? false,
    ledgerEntryId: newId(),
    referenceRetry,
    at: NOW,
  });
}

/** BET já aplicada na wallet, para servir de referência. */
function processedBet(wallet: Wallet, amount: string, externalTransactionId = `bet-${newId()}`) {
  const bet = aTransaction(Bet, amount, { externalTransactionId });
  settle(bet, wallet);
  expect(bet.status).toBe(WagerTransactionStatus.Processed);
  return bet;
}

describe('WagerSettlement', () => {
  describe('BET', () => {
    it('debita e gera um lançamento DEBIT', () => {
      const wallet = aWallet('100.00');
      const bet = aTransaction(Bet, '25.00');
      const outcome = settle(bet, wallet);

      expect(outcome.type).toBe('processed');
      expect(bet.status).toBe(WagerTransactionStatus.Processed);
      expect(wallet.balance.equals(brl('75.00'))).toBe(true);
      expect(bet.observedBalance?.equals(brl('75.00'))).toBe(true);
      if (outcome.type === 'processed') {
        expect(outcome.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
        expect(outcome.ledgerEntry?.transactionId).toBe(bet.id);
      }
    });

    it('rejeita por saldo insuficiente sem lançamento', () => {
      const wallet = aWallet('10.00');
      const bet = aTransaction(Bet, '25.00');
      const outcome = settle(bet, wallet);

      expect(outcome).toEqual({ type: 'rejected', failureCode: FailureCode.InsufficientFunds });
      expect(bet.status).toBe(WagerTransactionStatus.Rejected);
      expect(wallet.balance.equals(brl('10.00'))).toBe(true);
      expect(wallet.version).toBe(1);
    });

    it('cenário da seção 8: 100.00 e duas apostas de 80.00', () => {
      const wallet = aWallet('100.00');
      const first = aTransaction(Bet, '80.00');
      const second = aTransaction(Bet, '80.00');

      const outcomes = [settle(first, wallet), settle(second, wallet)];

      expect(outcomes.filter((o) => o.type === 'processed')).toHaveLength(1);
      expect(second.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(wallet.balance.equals(brl('20.00'))).toBe(true);
      expect(outcomes.filter((o) => o.type === 'processed' && o.ledgerEntry)).toHaveLength(1);
    });
  });

  describe('WIN', () => {
    it('credita sem referência', () => {
      const wallet = aWallet('100.00');
      const win = aTransaction(Win, '50.00');
      settle(win, wallet);
      expect(win.status).toBe(WagerTransactionStatus.Processed);
      expect(wallet.balance.equals(brl('150.00'))).toBe(true);
    });

    it('credita referenciando a BET da mesma rodada', () => {
      const wallet = aWallet('100.00');
      const bet = processedBet(wallet, '10.00');
      const win = aTransaction(Win, '30.00', { referenceExternalTransactionId: bet.externalTransactionId });
      settle(win, wallet, { reference: bet });

      expect(win.status).toBe(WagerTransactionStatus.Processed);
      expect(win.referenceTransactionId).toBe(bet.id);
      expect(wallet.balance.equals(brl('120.00'))).toBe(true);
    });

    it('rejeita referência a BET de outra rodada', () => {
      const wallet = aWallet('100.00');
      const bet = processedBet(wallet, '10.00');
      const win = aTransaction(Win, '30.00', {
        referenceExternalTransactionId: bet.externalTransactionId,
        roundId: 'other-round',
      });
      expect(settle(win, wallet, { reference: bet })).toEqual({
        type: 'rejected',
        failureCode: FailureCode.ReferenceMismatch,
      });
    });
  });

  describe('LOSS', () => {
    it('é processada sem mexer no saldo nem gerar lançamento', () => {
      const wallet = aWallet('100.00');
      const loss = aTransaction(Loss, '0.00');
      const outcome = settle(loss, wallet);

      expect(outcome).toEqual({ type: 'processed', ledgerEntry: undefined, reference: undefined });
      expect(loss.status).toBe(WagerTransactionStatus.Processed);
      expect(wallet.balance.equals(brl('100.00'))).toBe(true);
      expect(wallet.version).toBe(1);
    });
  });

  describe('REFUND', () => {
    it('devolve uma BET processada', () => {
      const wallet = aWallet('100.00');
      const bet = processedBet(wallet, '40.00');
      const refund = aTransaction(Refund, '40.00', { referenceExternalTransactionId: bet.externalTransactionId });
      const outcome = settle(refund, wallet, { reference: bet });

      expect(refund.status).toBe(WagerTransactionStatus.Processed);
      expect(wallet.balance.equals(brl('100.00'))).toBe(true);
      if (outcome.type === 'processed') {
        expect(outcome.ledgerEntry?.direction).toBe(LedgerDirection.Credit);
      }
    });

    it('só referencia BET', () => {
      const wallet = aWallet('100.00');
      const win = aTransaction(Win, '40.00');
      settle(win, wallet);
      const refund = aTransaction(Refund, '40.00', { referenceExternalTransactionId: win.externalTransactionId });
      expect(settle(refund, wallet, { reference: win })).toEqual({
        type: 'rejected',
        failureCode: FailureCode.InvalidReferenceKind,
      });
    });

    it('exige o mesmo valor da referência', () => {
      const wallet = aWallet('100.00');
      const bet = processedBet(wallet, '40.00');
      const refund = aTransaction(Refund, '39.99', { referenceExternalTransactionId: bet.externalTransactionId });
      expect(settle(refund, wallet, { reference: bet })).toEqual({
        type: 'rejected',
        failureCode: FailureCode.ReversalAmountMismatch,
      });
    });

    it('não reverte duas vezes', () => {
      const wallet = aWallet('100.00');
      const bet = processedBet(wallet, '40.00');
      const refund = aTransaction(Refund, '40.00', { referenceExternalTransactionId: bet.externalTransactionId });
      expect(settle(refund, wallet, { reference: bet, referenceAlreadyReversed: true })).toEqual({
        type: 'rejected',
        failureCode: FailureCode.ReferenceAlreadyReversed,
      });
      expect(wallet.balance.equals(brl('60.00'))).toBe(true);
    });
  });

  describe('ROLLBACK', () => {
    it('de BET credita', () => {
      const wallet = aWallet('100.00');
      const bet = processedBet(wallet, '40.00');
      const rollback = aTransaction(Rollback, '40.00', { referenceExternalTransactionId: bet.externalTransactionId });
      settle(rollback, wallet, { reference: bet });
      expect(rollback.status).toBe(WagerTransactionStatus.Processed);
      expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    });

    it('de WIN debita', () => {
      const wallet = aWallet('100.00');
      const win = aTransaction(Win, '50.00');
      settle(win, wallet);
      const rollback = aTransaction(Rollback, '50.00', { referenceExternalTransactionId: win.externalTransactionId });
      settle(rollback, wallet, { reference: win });
      expect(rollback.status).toBe(WagerTransactionStatus.Processed);
      expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    });

    it('de REFUND debita', () => {
      const wallet = aWallet('100.00');
      const bet = processedBet(wallet, '40.00');
      const refund = aTransaction(Refund, '40.00', { referenceExternalTransactionId: bet.externalTransactionId });
      settle(refund, wallet, { reference: bet });
      const rollback = aTransaction(Rollback, '40.00', { referenceExternalTransactionId: refund.externalTransactionId });
      settle(rollback, wallet, { reference: refund });
      expect(rollback.status).toBe(WagerTransactionStatus.Processed);
      expect(wallet.balance.equals(brl('60.00'))).toBe(true);
    });

    it('que deixaria o saldo negativo é rejeitado com código próprio', () => {
      const wallet = aWallet('100.00');
      const win = aTransaction(Win, '50.00');
      settle(win, wallet);
      processedBet(wallet, '120.00');
      const rollback = aTransaction(Rollback, '50.00', { referenceExternalTransactionId: win.externalTransactionId });

      expect(settle(rollback, wallet, { reference: win })).toEqual({
        type: 'rejected',
        failureCode: FailureCode.ReversalInsufficientFunds,
      });
      expect(rollback.observedBalance?.equals(brl('30.00'))).toBe(true);
      expect(wallet.balance.equals(brl('30.00'))).toBe(true);
    });

    it('não referencia LOSS', () => {
      const wallet = aWallet('100.00');
      const loss = aTransaction(Loss, '10.00');
      settle(loss, wallet);
      const rollback = aTransaction(Rollback, '10.00', { referenceExternalTransactionId: loss.externalTransactionId });
      expect(settle(rollback, wallet, { reference: loss })).toEqual({
        type: 'rejected',
        failureCode: FailureCode.InvalidReferenceKind,
      });
    });
  });

  describe('referências', () => {
    it('referência ausente deixa a transação PENDING_REFERENCE', () => {
      const wallet = aWallet('100.00');
      const refund = aTransaction(Refund, '40.00', { referenceExternalTransactionId: 'bet-ainda-nao-chegou' });
      expect(settle(refund, wallet)).toEqual({ type: 'pending_reference' });
      expect(refund.status).toBe(WagerTransactionStatus.PendingReference);
      expect(refund.referenceAttempts).toBe(1);
      expect(wallet.version).toBe(1);
    });

    it('referência que chega depois é aplicada no reprocessamento', () => {
      const wallet = aWallet('100.00');
      const rollback = aTransaction(Rollback, '40.00', { referenceExternalTransactionId: 'bet-1' });
      settle(rollback, wallet);

      const bet = processedBet(wallet, '40.00', 'bet-1');
      settle(rollback, wallet, { reference: bet });

      expect(rollback.status).toBe(WagerTransactionStatus.Processed);
      expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    });

    it('esgotadas as tentativas, rejeita com REFERENCE_NOT_FOUND', () => {
      const wallet = aWallet('100.00');
      const refund = aTransaction(Refund, '40.00', { referenceExternalTransactionId: 'nunca-chega' });
      for (let attempt = 1; attempt <= referenceRetry.maxAttempts; attempt++) {
        expect(settle(refund, wallet).type).toBe('pending_reference');
      }
      expect(settle(refund, wallet)).toEqual({ type: 'rejected', failureCode: FailureCode.ReferenceNotFound });
    });

    it('referência ainda pendente continua aguardando', () => {
      const wallet = aWallet('100.00');
      const refund = aTransaction(Refund, '40.00', { referenceExternalTransactionId: 'bet-x' });
      settle(refund, wallet);
      const rollback = aTransaction(Rollback, '40.00', { referenceExternalTransactionId: refund.externalTransactionId });
      expect(settle(rollback, wallet, { reference: refund })).toEqual({ type: 'pending_reference' });
    });

    it('referência rejeitada não pode ser revertida', () => {
      const wallet = aWallet('10.00');
      const bet = aTransaction(Bet, '40.00');
      settle(bet, wallet);
      const refund = aTransaction(Refund, '40.00', { referenceExternalTransactionId: bet.externalTransactionId });
      expect(settle(refund, wallet, { reference: bet })).toEqual({
        type: 'rejected',
        failureCode: FailureCode.ReferenceNotProcessed,
      });
    });

    it('referência de outro jogador é rejeitada', () => {
      const wallet = aWallet('100.00');
      const bet = processedBet(wallet, '40.00');
      const otherWallet = aWallet('100.00', { playerId: 'outro-jogador' });
      const refund = aTransaction(Refund, '40.00', {
        referenceExternalTransactionId: bet.externalTransactionId,
        playerId: 'outro-jogador',
      });
      expect(settle(refund, otherWallet, { reference: bet })).toEqual({
        type: 'rejected',
        failureCode: FailureCode.ReferenceMismatch,
      });
    });
  });

  describe('validações da wallet', () => {
    it('conflito de moeda é rejeitado sem lançamento e sem saldo em outra moeda', () => {
      const wallet = aWallet('100.00');
      const bet = aTransaction(Bet, '10.00', { money: usd('10.00') });
      expect(settle(bet, wallet)).toEqual({ type: 'rejected', failureCode: FailureCode.CurrencyMismatch });
      expect(bet.observedBalance).toBeUndefined();
      expect(wallet.balance.equals(brl('100.00'))).toBe(true);
      expect(wallet.version).toBe(1);
    });

    it('jogador diferente do dono da wallet é rejeitado sem expor o saldo', () => {
      const wallet = aWallet('100.00', { playerId: 'dono' });
      const bet = aTransaction(Bet, '10.00');
      expect(settle(bet, wallet)).toEqual({ type: 'rejected', failureCode: FailureCode.PlayerWalletMismatch });
      expect(bet.observedBalance).toBeUndefined();
    });

    it('nas demais rejeições registra o saldo observado', () => {
      const wallet = aWallet('5.00');
      const bet = aTransaction(Bet, '10.00');
      settle(bet, wallet);
      expect(bet.observedBalance?.equals(brl('5.00'))).toBe(true);
    });

    it('transação terminal não é liquidada de novo', () => {
      const wallet = aWallet('100.00');
      const bet = processedBet(wallet, '10.00');
      expect(() => settle(bet, wallet)).toThrow(InvalidTransactionStateError);
      expect(wallet.balance.equals(brl('90.00'))).toBe(true);
    });
  });
});
