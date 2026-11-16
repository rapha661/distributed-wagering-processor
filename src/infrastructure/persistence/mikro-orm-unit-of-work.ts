import {
  ConnectionException,
  DeadlockException,
  type EntityManager,
  LockMode,
  LockWaitTimeoutException,
  type MikroORM,
  UniqueConstraintViolationException,
} from '@mikro-orm/postgresql';
import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { Wallet } from '../../domain/wallet/wallet';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { WagerTransactionKind, WagerTransactionStatus } from '../../domain/wagering/wager-types';
import { DuplicateKeyError, TransientFailureError, type UniqueKey } from '../../application/errors';
import type {
  LedgerRepository,
  OutboxRepository,
  TransactionalRepositories,
  UnitOfWork,
  WagerTransactionRepository,
  WalletRepository,
} from '../../application/ports';
import { LedgerEntryEntity, OutboxEntity, WagerTransactionEntity, WalletEntity, type WalletRecord } from './entities';
import {
  ledgerEntryData,
  outboxData,
  toWagerTransaction,
  toWallet,
  wagerTransactionData,
  walletData,
} from './mappers';

const UNIQUE_KEYS: Record<string, UniqueKey> = {
  wallets_player_currency_key: 'wallet-player-currency',
  wager_transactions_idempotency_key_key: 'transaction-idempotency-key',
  wager_transactions_provider_external_key: 'transaction-external-id',
  wager_transactions_single_reversal_idx: 'transaction-reversal',
};

// lock_not_available (lock_timeout), deadlock e falha de serialização
const LOCK_CONFLICT_CODES = new Set(['55P03', '40P01', '40001']);
const TRANSIENT_NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', '57P01', '57P03']);

/**
 * Unit of Work sobre `EntityManager.transactional()`: cada execução usa um EntityManager
 * novo (identity map limpo) e tudo é gravado num único flush no commit.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly lockTimeoutMs: number,
  ) {}

  async run<T>(work: (repositories: TransactionalRepositories) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        // espera limitada pelo lock da wallet: estourou, vira falha transitória (503 / retry)
        await em.execute(`set local lock_timeout = ${Math.trunc(this.lockTimeoutMs)}`);
        return work({
          wallets: new MikroOrmWalletRepository(em),
          transactions: new MikroOrmWagerTransactionRepository(em),
          ledger: new MikroOrmLedgerRepository(em),
          outbox: new MikroOrmOutboxRepository(em),
        });
      });
    } catch (error) {
      throw translatePersistenceError(error);
    }
  }
}

export function translatePersistenceError(error: unknown): unknown {
  if (error instanceof UniqueConstraintViolationException) {
    const constraint = (error as { constraint?: string }).constraint ?? '';
    return new DuplicateKeyError(UNIQUE_KEYS[constraint] ?? 'other', { cause: error });
  }
  const code = (error as { code?: unknown } | null)?.code;
  const isCode = (codes: ReadonlySet<string>) => typeof code === 'string' && codes.has(code);
  if (error instanceof LockWaitTimeoutException || error instanceof DeadlockException || isCode(LOCK_CONFLICT_CODES)) {
    return new TransientFailureError('LOCK_TIMEOUT', 'wallet is busy, retry later', { cause: error });
  }
  if (error instanceof ConnectionException || isCode(TRANSIENT_NETWORK_CODES)) {
    return new TransientFailureError('DEPENDENCY_UNAVAILABLE', 'database unavailable, retry later', { cause: error });
  }
  return error;
}

class MikroOrmWalletRepository implements WalletRepository {
  private readonly loaded = new Map<string, WalletRecord>();

  constructor(private readonly em: EntityManager) {}

  async lockById(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletEntity, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    if (!record) {
      return undefined;
    }
    this.loaded.set(id, record);
    return toWallet(record);
  }

  add(wallet: Wallet): void {
    this.em.create(WalletEntity, walletData(wallet));
  }

  update(wallet: Wallet): void {
    const record = this.loaded.get(wallet.id);
    if (!record) {
      throw new Error(`wallet ${wallet.id} must be locked before being updated`);
    }
    // entidade gerenciada: o flush gera o UPDATE só com as colunas alteradas
    const { balance, version, updatedAt } = walletData(wallet);
    Object.assign(record, { balance, version, updatedAt });
  }
}

class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionEntity, { idempotencyKey });
    return record ? toWagerTransaction(record) : undefined;
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionEntity, { providerId, externalTransactionId });
    return record ? toWagerTransaction(record) : undefined;
  }

  async hasProcessedReversal(transactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionEntity, {
      referenceTransactionId: transactionId,
      status: WagerTransactionStatus.Processed,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
    });
    return count > 0;
  }

  add(transaction: WagerTransaction): void {
    this.em.create(WagerTransactionEntity, wagerTransactionData(transaction));
  }
}

class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  add(entry: WalletLedgerEntry): void {
    this.em.create(LedgerEntryEntity, ledgerEntryData(entry));
  }
}

class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  add(message: OutboxMessage): void {
    this.em.create(OutboxEntity, outboxData(message));
  }
}
