import { z } from 'zod';
import { INTERNAL_PROVIDER_ID } from '../domain/wagering/wager-transaction';
import { WagerTransactionKind } from '../domain/wagering/wager-types';

export class RequestValidationError extends Error {
  constructor(
    readonly code: string,
    readonly details: { path: string; message: string }[],
  ) {
    super('request validation failed');
    this.name = 'RequestValidationError';
  }
}

const text = (max: number) => z.string().min(1).max(max);

// o formato do valor (escala, sinal, notação) é validado pelo Money, no domínio
const money = z.object({ amount: z.string(), currency: z.string() });

export const createWalletBody = z.object({
  playerId: z.uuid(),
  initialBalance: money,
});

export const submitWagerBody = z.object({
  providerId: text(128).refine((value) => value !== INTERNAL_PROVIDER_ID, 'providerId is reserved'),
  externalTransactionId: text(255),
  playerId: z.uuid(),
  walletId: z.uuid(),
  roundId: text(255),
  gameId: text(255),
  // OPENING é interno e fica de fora
  kind: z.enum([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Loss,
    WagerTransactionKind.Refund,
    WagerTransactionKind.Rollback,
  ]),
  money,
  referenceExternalTransactionId: text(255).optional(),
});

export const idempotencyKeyHeader = text(255);
export const uuidParam = z.uuid();
export const textParam = text(255);
export const ledgerQuery = z.object({
  cursor: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function parse<T>(schema: z.ZodType<T>, value: unknown, code = 'INVALID_PAYLOAD'): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new RequestValidationError(
      code,
      result.error.issues.map((issue) => ({ path: issue.path.join('.') || '(root)', message: issue.message })),
    );
  }
  return result.data;
}
