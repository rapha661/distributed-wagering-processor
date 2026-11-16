import { describe, expect, it } from 'bun:test';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  WagerTransaction,
} from '../../../src/domain/wagering/wager-transaction';
import { FailureCode, WagerTransactionKind, WagerTransactionStatus } from '../../../src/domain/wagering/wager-types';
import { LedgerDirection } from '../../../src/domain/ledger/wallet-ledger-entry';
import { InvalidStateError } from '../../../src/domain/shared/errors';
import { NOW, aTransaction, brl, referenceRetry } from '../fixtures';

const { Bet, Win, Loss, Refund, Rollback, Opening } = WagerTransactionKind;

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof InvalidWagerTransactionError ? error.code : undefined;
  }
  return undefined;
}

describe('WagerTransaction', () => {
  it('nasce PENDING, com hash do payload e sem tentativas', () => {
    const bet = aTransaction(Bet, '25.00');
    expect(bet.status).toBe(WagerTransactionStatus.Pending);
    expect(bet.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(bet.referenceAttempts).toBe(0);
    expect(bet.isTerminal()).toBe(false);
  });

  it('não aceita OPENING vindo de fora', () => {
    expect(codeOf(() => aTransaction(Opening, '10.00'))).toBe('UNSUPPORTED_KIND');
  });

  it('exige referência para REFUND e ROLLBACK', () => {
    expect(codeOf(() => aTransaction(Refund, '10.00'))).toBe('MISSING_REFERENCE');
    expect(codeOf(() => aTransaction(Rollback, '10.00'))).toBe('MISSING_REFERENCE');
    expect(codeOf(() => aTransaction(Refund, '10.00', { referenceExternalTransactionId: ' ' }))).toBe('INVALID_FIELD');
    expect(aTransaction(Refund, '10.00', { referenceExternalTransactionId: 'bet-1' }).requiresReference()).toBe(true);
  });

  it('exige valor positivo, exceto em LOSS', () => {
    expect(codeOf(() => aTransaction(Bet, '0.00'))).toBe('INVALID_AMOUNT');
    expect(codeOf(() => aTransaction(Win, '0.00'))).toBe('INVALID_AMOUNT');
    expect(aTransaction(Loss, '0.00').status).toBe(WagerTransactionStatus.Pending);
  });

  it('exige os identificadores', () => {
    expect(codeOf(() => aTransaction(Bet, '1.00', { roundId: '' }))).toBe('INVALID_FIELD');
    expect(codeOf(() => aTransaction(Bet, '1.00', { idempotencyKey: '  ' }))).toBe('INVALID_FIELD');
  });

  it('cria a transação OPENING já processada', () => {
    const opening = WagerTransaction.opening({ id: 't-1', walletId: 'w-1', playerId: 'p-1', money: brl('1000.00'), at: NOW });
    expect(opening.kind).toBe(Opening);
    expect(opening.status).toBe(WagerTransactionStatus.Processed);
    expect(opening.observedBalance?.equals(brl('1000.00'))).toBe(true);
  });

  describe('transições', () => {
    it('PENDING -> PROCESSED', () => {
      const bet = aTransaction(Bet, '25.00');
      bet.markProcessed(undefined, NOW, brl('75.00'));
      expect(bet.status).toBe(WagerTransactionStatus.Processed);
      expect(bet.processedAt).toEqual(NOW);
      expect(bet.observedBalance?.equals(brl('75.00'))).toBe(true);
    });

    it('PENDING -> PENDING_REFERENCE -> PROCESSED, agendando com backoff', () => {
      const refund = aTransaction(Refund, '25.00', { referenceExternalTransactionId: 'bet-1' });
      refund.markPendingReference(NOW, brl('75.00'), referenceRetry);
      expect(refund.status).toBe(WagerTransactionStatus.PendingReference);
      expect(refund.referenceAttempts).toBe(1);
      expect(refund.nextReferenceAttemptAt?.getTime()).toBe(NOW.getTime() + 2_000);

      refund.markPendingReference(NOW, brl('75.00'), referenceRetry);
      expect(refund.referenceAttempts).toBe(2);
      expect(refund.nextReferenceAttemptAt?.getTime()).toBe(NOW.getTime() + 4_000);

      refund.markProcessed('bet-id', NOW, brl('100.00'));
      expect(refund.status).toBe(WagerTransactionStatus.Processed);
      expect(refund.referenceTransactionId).toBe('bet-id');
      expect(refund.nextReferenceAttemptAt).toBeUndefined();
    });

    it('PENDING -> REJECTED e PENDING -> FAILED guardam o código', () => {
      const rejected = aTransaction(Bet, '25.00');
      rejected.reject(FailureCode.InsufficientFunds, NOW, brl('10.00'));
      expect(rejected.status).toBe(WagerTransactionStatus.Rejected);
      expect(rejected.failureCode).toBe(FailureCode.InsufficientFunds);

      const failed = aTransaction(Bet, '25.00');
      failed.fail(FailureCode.ProcessingFailed, NOW);
      expect(failed.status).toBe(WagerTransactionStatus.Failed);
    });

    const terminals: [string, (tx: WagerTransaction) => void][] = [
      ['PROCESSED', (tx) => tx.markProcessed(undefined, NOW, brl('1.00'))],
      ['REJECTED', (tx) => tx.reject(FailureCode.InsufficientFunds, NOW, brl('1.00'))],
      ['FAILED', (tx) => tx.fail(FailureCode.ProcessingFailed, NOW)],
    ];
    const transitions: [string, (tx: WagerTransaction) => void][] = [
      ['markProcessed', (tx) => tx.markProcessed(undefined, NOW, brl('1.00'))],
      ['markPendingReference', (tx) => tx.markPendingReference(NOW, brl('1.00'), referenceRetry)],
      ['reject', (tx) => tx.reject(FailureCode.InsufficientFunds, NOW, brl('1.00'))],
      ['fail', (tx) => tx.fail(FailureCode.ProcessingFailed, NOW)],
    ];

    for (const [terminal, reach] of terminals) {
      for (const [name, transition] of transitions) {
        it(`${terminal} é terminal: ${name} lança InvalidTransactionStateError`, () => {
          const tx = aTransaction(Bet, '1.00');
          reach(tx);
          const before = tx.status;
          expect(() => transition(tx)).toThrow(InvalidTransactionStateError);
          expect(tx.status).toBe(before);
          expect(tx.isTerminal()).toBe(true);
        });
      }
    }
  });

  it('reidrata estado terminal sem revalidar', () => {
    const bet = aTransaction(Bet, '25.00');
    bet.reject(FailureCode.InsufficientFunds, NOW, brl('0.00'));
    const restored = WagerTransaction.rehydrate({
      id: bet.id,
      providerId: bet.providerId,
      externalTransactionId: bet.externalTransactionId,
      idempotencyKey: bet.idempotencyKey,
      payloadHash: bet.payloadHash,
      walletId: bet.walletId,
      playerId: bet.playerId,
      roundId: bet.roundId,
      gameId: bet.gameId,
      kind: bet.kind,
      money: bet.money,
      referenceExternalTransactionId: undefined,
      createdAt: bet.createdAt,
      updatedAt: bet.updatedAt,
      status: bet.status,
      referenceTransactionId: undefined,
      failureCode: bet.failureCode,
      processedAt: undefined,
      observedBalance: bet.observedBalance,
      referenceAttempts: 0,
      nextReferenceAttemptAt: undefined,
    });
    expect(restored.status).toBe(WagerTransactionStatus.Rejected);
    expect(restored.failureCode).toBe(FailureCode.InsufficientFunds);
  });

  describe('consultas', () => {
    it('LOSS é a única que não mexe no saldo', () => {
      expect(aTransaction(Loss, '0.00').affectsBalance()).toBe(false);
      expect(aTransaction(Bet, '1.00').affectsBalance()).toBe(true);
      expect(aTransaction(Win, '1.00').affectsBalance()).toBe(true);
    });

    it('direção do ledger por kind', () => {
      const bet = aTransaction(Bet, '10.00');
      const win = aTransaction(Win, '10.00');
      const refund = aTransaction(Refund, '10.00', { referenceExternalTransactionId: 'b' });
      const rollback = aTransaction(Rollback, '10.00', { referenceExternalTransactionId: 'b' });

      expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
      expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
      expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
      expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
      expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
      expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
      expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidStateError);
      expect(() => aTransaction(Loss, '0.00').ledgerDirectionFor()).toThrow(InvalidStateError);
    });

    it('tipos que cada kind pode referenciar', () => {
      const refund = aTransaction(Refund, '1.00', { referenceExternalTransactionId: 'b' });
      const rollback = aTransaction(Rollback, '1.00', { referenceExternalTransactionId: 'b' });
      expect(refund.canReference(Bet)).toBe(true);
      expect(refund.canReference(Win)).toBe(false);
      expect([Bet, Win, Refund].every((kind) => rollback.canReference(kind))).toBe(true);
      expect(rollback.canReference(Loss)).toBe(false);
      expect(rollback.canReference(Rollback)).toBe(false);
    });
  });
});
