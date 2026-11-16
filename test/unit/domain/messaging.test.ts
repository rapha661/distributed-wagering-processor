import { describe, expect, it } from 'bun:test';
import { InboxMessage } from '../../../src/domain/messaging/inbox-message';
import { OutboxMessage } from '../../../src/domain/messaging/outbox-message';
import { BackoffPolicy } from '../../../src/domain/shared/backoff-policy';
import { InvalidStateError } from '../../../src/domain/shared/errors';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../../src/domain/events/wagering-events';
import { FailureCode, WagerTransactionKind } from '../../../src/domain/wagering/wager-types';
import { NOW, aTransaction, aWallet, brl, eventContext, newId, referenceRetry } from '../fixtures';

const at = (ms: number) => new Date(NOW.getTime() + ms);

describe('BackoffPolicy', () => {
  it('cresce exponencialmente até o teto', () => {
    const policy = new BackoffPolicy(1_000, 10_000, 5);
    expect([1, 2, 3, 4, 5, 6].map((attempt) => policy.delayMs(attempt))).toEqual([
      1_000, 2_000, 4_000, 8_000, 10_000, 10_000,
    ]);
    expect(policy.isExhausted(4)).toBe(false);
    expect(policy.isExhausted(5)).toBe(true);
  });
});

describe('OutboxMessage', () => {
  function anEvent() {
    const wallet = aWallet('100.00');
    const entry = wallet.debit({ transactionId: newId(), entryId: newId(), money: brl('25.00'), at: NOW });
    return WalletBalanceChanged.from(wallet, entry, eventContext());
  }

  it('enfileira o envelope do evento, pronto para publicar', () => {
    const event = anEvent();
    const message = OutboxMessage.enqueue(event);

    expect(message.id).toBe(event.eventId);
    expect(message.aggregateId).toBe(event.aggregateId);
    expect(message.eventType).toBe('WalletBalanceChanged');
    expect(message.payload).toEqual(event.toJSON());
    expect(message.attempts).toBe(0);
    expect(message.isPending()).toBe(true);
    expect(message.isDue(NOW)).toBe(true);
  });

  it('agenda novas tentativas com backoff', () => {
    const message = OutboxMessage.enqueue(anEvent());
    const policy = new BackoffPolicy(1_000, 60_000);

    message.scheduleRetry(NOW, policy);
    expect(message.attempts).toBe(1);
    expect(message.isDue(at(999))).toBe(false);
    expect(message.isDue(at(1_000))).toBe(true);

    message.scheduleRetry(NOW, policy);
    expect(message.nextAttemptAt).toEqual(at(2_000));
  });

  it('publicada não volta a ser pendente', () => {
    const message = OutboxMessage.enqueue(anEvent());
    message.markPublished(NOW);

    expect(message.isPending()).toBe(false);
    expect(message.isDue(at(60_000))).toBe(false);
    expect(() => message.markPublished(NOW)).toThrow(InvalidStateError);
    expect(() => message.scheduleRetry(NOW)).toThrow(InvalidStateError);
  });
});

describe('InboxMessage', () => {
  it('registra o processamento uma única vez', () => {
    const inbox = InboxMessage.receive({ messageId: 'msg-123', consumerName: 'wager-consumer', payloadHash: 'h', receivedAt: NOW });
    expect(inbox.isProcessed()).toBe(false);

    inbox.markProcessed(NOW);
    expect(inbox.isProcessed()).toBe(true);
    expect(inbox.processedAt).toEqual(NOW);
    expect(() => inbox.markProcessed(NOW)).toThrow(InvalidStateError);
  });

  it('identifica payload divergente para o mesmo messageId', () => {
    const inbox = InboxMessage.receive({ messageId: 'msg-123', consumerName: 'c', payloadHash: 'h1', receivedAt: NOW });
    expect(inbox.matchesPayload('h1')).toBe(true);
    expect(inbox.matchesPayload('h2')).toBe(false);
  });
});

describe('IntegrationEvent', () => {
  it('serializa o envelope com MoneyProps e data ISO', () => {
    const wallet = aWallet('100.00');
    const entry = wallet.debit({ transactionId: 't-1', entryId: 'e-1', money: brl('25.00'), at: NOW });
    const ctx = eventContext({ eventId: 'evt-1', causationId: 'msg-123' });
    const json: unknown = WalletBalanceChanged.from(wallet, entry, ctx).toJSON();

    expect(json).toEqual({
      eventId: 'evt-1',
      eventType: 'WalletBalanceChanged',
      aggregateId: wallet.id,
      correlationId: 'corr-1',
      causationId: 'msg-123',
      occurredAt: '2026-07-29T15:00:00.000Z',
      version: 1,
      data: {
        walletId: wallet.id,
        transactionId: 't-1',
        direction: 'DEBIT',
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '75.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  it('omite causationId quando não existe', () => {
    const loss = aTransaction(WagerTransactionKind.Loss, '0.00');
    loss.markProcessed(undefined, NOW, brl('100.00'));
    const json = WagerTransactionProcessed.from(loss, eventContext()).toJSON();
    expect('causationId' in json).toBe(false);
    expect(json.data.balance).toEqual({ amount: '100.00', currency: 'BRL' });
  });

  it('cada evento exige o status correspondente', () => {
    const bet = aTransaction(WagerTransactionKind.Bet, '10.00');
    expect(() => WagerTransactionProcessed.from(bet, eventContext())).toThrow(InvalidStateError);
    expect(() => WagerTransactionRejected.from(bet, eventContext())).toThrow(InvalidStateError);
    expect(() => WagerTransactionPendingReference.from(bet, eventContext())).toThrow(InvalidStateError);

    bet.reject(FailureCode.InsufficientFunds, NOW, brl('5.00'));
    const rejected: unknown = WagerTransactionRejected.from(bet, eventContext()).toJSON();
    expect(rejected).toMatchObject({ data: { failureCode: 'INSUFFICIENT_FUNDS' } });
  });

  it('evento de referência pendente carrega a próxima tentativa', () => {
    const refund = aTransaction(WagerTransactionKind.Refund, '10.00', { referenceExternalTransactionId: 'bet-1' });
    refund.markPendingReference(NOW, brl('100.00'), referenceRetry);
    const event = WagerTransactionPendingReference.from(refund, eventContext());
    expect(event.data.attempts).toBe(1);
    expect(event.data.nextAttemptAt).toBe(at(2_000).toISOString());
  });
});
