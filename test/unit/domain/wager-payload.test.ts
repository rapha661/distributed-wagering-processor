import { describe, expect, it } from 'bun:test';
import { canonicalJson } from '../../../src/domain/shared/canonical-json';
import { type WagerRequest, wagerPayloadHash } from '../../../src/domain/wagering/wager-payload';
import { WagerTransactionKind } from '../../../src/domain/wagering/wager-types';
import { PLAYER_ID, WALLET_ID, aTransaction, brl } from '../fixtures';

const request: WagerRequest = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: PLAYER_ID,
  walletId: WALLET_ID,
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: WagerTransactionKind.Bet,
  money: brl('25.00'),
};

describe('canonicalJson', () => {
  it('ordena chaves em qualquer nível e omite undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });
});

describe('payloadHash', () => {
  it('não depende da ordem das chaves', () => {
    const reordered = Object.fromEntries(Object.entries(request).reverse()) as unknown as WagerRequest;
    expect(wagerPayloadHash(reordered)).toBe(wagerPayloadHash(request));
  });

  it('usa o valor normalizado', () => {
    expect(wagerPayloadHash({ ...request, money: brl('25') })).toBe(wagerPayloadHash(request));
  });

  it.each([
    ['providerId', { providerId: 'provider-b' }],
    ['externalTransactionId', { externalTransactionId: 'transaction-124' }],
    ['playerId', { playerId: '0192f28f-0000-7d58-bdb2-814ad6a0f4a1' }],
    ['walletId', { walletId: '0192f291-0000-7d3f-8071-5f8685deef37' }],
    ['roundId', { roundId: 'round-988' }],
    ['gameId', { gameId: 'other-game' }],
    ['kind', { kind: WagerTransactionKind.Win }],
    ['money', { money: brl('25.01') }],
    ['referenceExternalTransactionId', { referenceExternalTransactionId: 'bet-1' }],
  ] as const)('muda quando %s muda', (_, change) => {
    expect(wagerPayloadHash({ ...request, ...change })).not.toBe(wagerPayloadHash(request));
  });
});

describe('idempotency key x payload', () => {
  it('a key não entra no hash: mesmo payload com keys diferentes gera o mesmo hash', () => {
    const a = aTransaction(WagerTransactionKind.Bet, '25.00', { externalTransactionId: 't-1', idempotencyKey: 'k-1' });
    const b = aTransaction(WagerTransactionKind.Bet, '25.00', { externalTransactionId: 't-1', idempotencyKey: 'k-2' });
    expect(a.payloadHash).toBe(b.payloadHash);
  });

  it('mesma key com payload divergente é conflito, não replay', () => {
    const original = aTransaction(WagerTransactionKind.Bet, '25.00', { externalTransactionId: 't-1', idempotencyKey: 'k-1' });
    const retry = aTransaction(WagerTransactionKind.Bet, '25.00', { externalTransactionId: 't-1', idempotencyKey: 'k-1' });
    const divergent = aTransaction(WagerTransactionKind.Bet, '30.00', { externalTransactionId: 't-1', idempotencyKey: 'k-1' });

    expect(original.matchesPayload(retry.payloadHash)).toBe(true);
    expect(original.matchesPayload(divergent.payloadHash)).toBe(false);
  });
});
