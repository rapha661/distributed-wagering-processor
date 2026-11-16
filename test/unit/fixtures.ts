import { Money } from '../../src/domain/money/money';
import { Wallet } from '../../src/domain/wallet/wallet';
import { BackoffPolicy } from '../../src/domain/shared/backoff-policy';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
} from '../../src/domain/wagering/wager-transaction';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-types';
import type { EventContext } from '../../src/domain/events/integration-event';

export const NOW = new Date('2026-07-29T15:00:00.000Z');
export const PLAYER_ID = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
export const WALLET_ID = '0192f291-27dd-7d3f-8071-5f8685deef37';

export const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
export const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

export const newId = () => crypto.randomUUID();

export const referenceRetry = new BackoffPolicy(2_000, 300_000, 3);

export function aWallet(balance = '100.00', overrides: { id?: string; playerId?: string } = {}): Wallet {
  return Wallet.rehydrate({
    id: overrides.id ?? WALLET_ID,
    playerId: overrides.playerId ?? PLAYER_ID,
    currency: 'BRL',
    balance: brl(balance),
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

export function aTransaction(
  kind: WagerTransactionKind,
  amount: string,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const externalTransactionId = overrides.externalTransactionId ?? `tx-${newId()}`;
  return WagerTransaction.create({
    id: newId(),
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId: PLAYER_ID,
    walletId: WALLET_ID,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind,
    money: brl(amount),
    createdAt: NOW,
    ...overrides,
  });
}

export function eventContext(overrides: Partial<EventContext> = {}): EventContext {
  return { eventId: newId(), correlationId: 'corr-1', occurredAt: NOW, ...overrides };
}
