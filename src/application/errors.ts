export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND';

  constructor(walletId: string) {
    super(`wallet ${walletId} not found`);
  }
}

export class TransactionNotFoundError extends ApplicationError {
  readonly code = 'TRANSACTION_NOT_FOUND';

  constructor(reference: string) {
    super(`transaction ${reference} not found`);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(playerId: string, currency: string) {
    super(`player ${playerId} already has a ${currency} wallet`);
  }
}

/** Mesma idempotency key com payload diferente: conflito, não replay. */
export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_KEY_REUSED';

  constructor(idempotencyKey: string) {
    super(`idempotency key ${idempotencyKey} was already used with a different payload`);
  }
}

export class ExternalTransactionConflictError extends ApplicationError {
  readonly code = 'EXTERNAL_ID_REUSED';

  constructor(providerId: string, externalTransactionId: string) {
    super(`${providerId}:${externalTransactionId} was already submitted with another idempotency key`);
  }
}

/** Mesmo messageId da fila já consumido com outro conteúdo. */
export class MessageConflictError extends ApplicationError {
  readonly code = 'MESSAGE_ID_REUSED';

  constructor(messageId: string) {
    super(`message ${messageId} was already consumed with a different payload`);
  }
}

export class InvalidRequestError extends ApplicationError {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Falha temporária de infraestrutura. Nada foi gravado e a operação pode ser repetida. */
export class TransientFailureError extends ApplicationError {
  constructor(
    readonly code: 'LOCK_TIMEOUT' | 'DEPENDENCY_UNAVAILABLE',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export type UniqueKey =
  | 'wallet-player-currency'
  | 'transaction-idempotency-key'
  | 'transaction-external-id'
  | 'transaction-reversal'
  | 'inbox-message'
  | 'other';

/** Violação de unicidade detectada pelo banco, em geral por uma corrida entre instâncias. */
export class DuplicateKeyError extends Error {
  constructor(
    readonly key: UniqueKey,
    options?: ErrorOptions,
  ) {
    super(`duplicate key: ${key}`, options);
    this.name = 'DuplicateKeyError';
  }
}
