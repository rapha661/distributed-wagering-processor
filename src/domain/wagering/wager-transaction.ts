import type { Money } from '../money/money';
import { LedgerDirection } from '../ledger/wallet-ledger-entry';
import type { BackoffPolicy } from '../shared/backoff-policy';
import { DomainError, InvalidStateError } from '../shared/errors';
import { wagerPayloadHash, type WagerRequest } from './wager-payload';
import { FailureCode, WagerTransactionKind, WagerTransactionStatus } from './wager-types';

export const INTERNAL_PROVIDER_ID = 'internal';

export interface CreateWagerTransactionProps extends WagerRequest {
  id: string;
  idempotencyKey: string;
  createdAt: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
  createdAt: Date;
  updatedAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId: string | undefined;
  failureCode: FailureCode | undefined;
  processedAt: Date | undefined;
  /** Saldo da wallet no momento da decisão, devolvido nos replays. */
  observedBalance: Money | undefined;
  referenceAttempts: number;
  nextReferenceAttemptAt: Date | undefined;
}

export type InvalidWagerTransactionCode =
  | 'UNSUPPORTED_KIND'
  | 'MISSING_REFERENCE'
  | 'INVALID_AMOUNT'
  | 'INVALID_FIELD';

export class InvalidWagerTransactionError extends DomainError {
  constructor(
    readonly code: InvalidWagerTransactionCode,
    message: string,
  ) {
    super(message);
  }
}

export class InvalidTransactionStateError extends InvalidStateError {}

const TERMINAL_STATUSES: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/** Que tipos cada kind pode referenciar. REFUND e ROLLBACK exigem referência; os demais, opcional. */
const REFERENCEABLE_KINDS: Record<WagerTransactionKind, readonly WagerTransactionKind[]> = {
  [WagerTransactionKind.Opening]: [],
  [WagerTransactionKind.Bet]: [],
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};

/**
 * Transições válidas:
 *
 *   PENDING ──────────────┬──> PROCESSED
 *      │                  ├──> REJECTED
 *      v                  └──> FAILED
 *   PENDING_REFERENCE ────┘    (e PENDING_REFERENCE -> PENDING_REFERENCE a cada nova tentativa)
 *
 * PROCESSED, REJECTED e FAILED são terminais.
 */
export class WagerTransaction {
  private constructor(
    readonly id: string,
    readonly providerId: string,
    readonly externalTransactionId: string,
    readonly idempotencyKey: string,
    readonly payloadHash: string,
    readonly walletId: string,
    readonly playerId: string,
    readonly roundId: string,
    readonly gameId: string,
    readonly kind: WagerTransactionKind,
    readonly money: Money,
    /** id no provedor, não o id interno */
    readonly referenceExternalTransactionId: string | undefined,
    readonly createdAt: Date,
    private _updatedAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
    private _observedBalance: Money | undefined,
    private _referenceAttempts: number,
    private _nextReferenceAttemptAt: Date | undefined,
  ) {}

  /** Transação vinda de um provedor. Nasce em PENDING. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError('UNSUPPORTED_KIND', 'OPENING is internal and cannot be submitted');
    }
    return WagerTransaction.build(props);
  }

  /** Crédito de abertura da wallet, já aplicado. */
  static opening(props: { id: string; walletId: string; playerId: string; money: Money; at: Date }): WagerTransaction {
    const transaction = WagerTransaction.build({
      id: props.id,
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId: `opening:${props.walletId}`,
      idempotencyKey: `opening:${props.walletId}`,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: 'opening',
      gameId: 'opening',
      kind: WagerTransactionKind.Opening,
      money: props.money,
      createdAt: props.at,
    });
    transaction.markProcessed(undefined, props.at, props.money);
    return transaction;
  }

  /** Reconstrói estado já persistido, sem revalidar regras nem transições. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.updatedAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.observedBalance,
      state.referenceAttempts,
      state.nextReferenceAttemptAt,
    );
  }

  private static build(props: CreateWagerTransactionProps): WagerTransaction {
    for (const field of [
      'id',
      'idempotencyKey',
      'providerId',
      'externalTransactionId',
      'playerId',
      'walletId',
      'roundId',
      'gameId',
    ] as const) {
      if (typeof props[field] !== 'string' || props[field].trim() === '') {
        throw new InvalidWagerTransactionError('INVALID_FIELD', `${field} is required`);
      }
    }
    if (!Object.values(WagerTransactionKind).includes(props.kind)) {
      throw new InvalidWagerTransactionError('UNSUPPORTED_KIND', `unknown kind ${String(props.kind)}`);
    }

    const reference = props.referenceExternalTransactionId;
    if (reference !== undefined && reference.trim() === '') {
      throw new InvalidWagerTransactionError('INVALID_FIELD', 'referenceExternalTransactionId cannot be blank');
    }
    if (reference === undefined && requiresReference(props.kind)) {
      throw new InvalidWagerTransactionError('MISSING_REFERENCE', `${props.kind} requires referenceExternalTransactionId`);
    }

    const validAmount = props.kind === WagerTransactionKind.Loss ? !props.money.isNegative() : props.money.isPositive();
    if (!validAmount) {
      throw new InvalidWagerTransactionError('INVALID_AMOUNT', `invalid amount for ${props.kind}: ${props.money}`);
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      wagerPayloadHash(props),
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      reference,
      props.createdAt,
      props.createdAt,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt;
  }

  // ---- transições

  markProcessed(referenceTransactionId: string | undefined, at: Date, observedBalance: Money): void {
    this.assertNotTerminal('markProcessed');
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._observedBalance = observedBalance;
    this._nextReferenceAttemptAt = undefined;
    this._updatedAt = at;
  }

  /** Estaciona a transação até a referência chegar e agenda a próxima tentativa. */
  markPendingReference(at: Date, observedBalance: Money, retry: BackoffPolicy): void {
    this.assertNotTerminal('markPendingReference');
    this._status = WagerTransactionStatus.PendingReference;
    this._referenceAttempts += 1;
    this._nextReferenceAttemptAt = retry.nextAttemptAt(at, this._referenceAttempts);
    this._observedBalance = observedBalance;
    this._updatedAt = at;
  }

  reject(code: FailureCode, at: Date, observedBalance: Money | undefined): void {
    this.assertNotTerminal('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._observedBalance = observedBalance;
    this._nextReferenceAttemptAt = undefined;
    this._updatedAt = at;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._nextReferenceAttemptAt = undefined;
    this._updatedAt = at;
  }

  // ---- consultas

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return requiresReference(this.kind);
  }

  isReversal(): boolean {
    return requiresReference(this.kind);
  }

  canReference(kind: WagerTransactionKind): boolean {
    return REFERENCEABLE_KINDS[this.kind].includes(kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidStateError('ROLLBACK direction depends on the referenced transaction');
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidStateError('LOSS does not move balance');
    }
  }

  private assertNotTerminal(transition: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`cannot ${transition}: transaction ${this.id} is ${this._status}`);
    }
  }
}

function requiresReference(kind: WagerTransactionKind): boolean {
  return kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;
}
