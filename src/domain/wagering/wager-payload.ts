import { createHash } from 'node:crypto';
import type { Money } from '../money/money';
import { canonicalJson } from '../shared/canonical-json';
import type { WagerTransactionKind } from './wager-types';

/** Campos de negócio de uma transação. Só eles entram no payloadHash. */
export interface WagerRequest {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
}

/**
 * SHA-256 (hex) do JSON canônico dos campos de negócio. O valor entra já
 * normalizado (`"25"` e `"25.00"` geram o mesmo hash). A idempotency key e os
 * metadados de transporte ficam de fora.
 */
export function wagerPayloadHash(request: WagerRequest): string {
  const payload = canonicalJson({
    providerId: request.providerId,
    externalTransactionId: request.externalTransactionId,
    playerId: request.playerId,
    walletId: request.walletId,
    roundId: request.roundId,
    gameId: request.gameId,
    kind: request.kind,
    money: request.money.toJSON(),
    referenceExternalTransactionId: request.referenceExternalTransactionId,
  });
  return createHash('sha256').update(payload).digest('hex');
}
