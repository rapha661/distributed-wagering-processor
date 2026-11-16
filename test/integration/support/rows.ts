import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';

type Connection = ReturnType<MikroORM['em']['getConnection']>;

export interface WalletRow {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
}

export interface TransactionRow {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  kind: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: string;
  failureCode: string | null;
  processedAt: string | null;
  nextReferenceAttemptAt: string | null;
}

export interface LedgerRow {
  id: string;
  walletId: string;
  transactionId: string;
  walletVersion: number;
  direction: string;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
}

const now = () => new Date().toISOString();

export async function insertWallet(db: Connection, overrides: Partial<WalletRow> = {}): Promise<WalletRow> {
  const row: WalletRow = {
    id: randomUUID(),
    playerId: randomUUID(),
    currency: 'BRL',
    balance: '100.00',
    version: 1,
    ...overrides,
  };
  await db.execute(
    `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
     values (?, ?, ?, ?, ?, now(), now())`,
    [row.id, row.playerId, row.currency, row.balance, row.version],
  );
  return row;
}

export async function insertTransaction(
  db: Connection,
  wallet: WalletRow,
  overrides: Partial<TransactionRow> = {},
): Promise<TransactionRow> {
  const externalTransactionId = overrides.externalTransactionId ?? `tx-${randomUUID()}`;
  const status = overrides.status ?? 'PROCESSED';
  const row: TransactionRow = {
    id: randomUUID(),
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    walletId: wallet.id,
    playerId: wallet.playerId,
    kind: 'BET',
    amount: '10.00',
    currency: wallet.currency,
    referenceExternalTransactionId: null,
    referenceTransactionId: null,
    status,
    failureCode: null,
    processedAt: status === 'PROCESSED' ? now() : null,
    nextReferenceAttemptAt: status === 'PENDING_REFERENCE' ? now() : null,
    ...overrides,
  };
  await db.execute(
    `insert into wager_transactions (
       id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
       round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id,
       status, failure_code, observed_balance, next_reference_attempt_at, created_at, updated_at, processed_at
     ) values (?, ?, ?, ?, ?, ?, ?, 'round-1', 'game-1', ?, ?, ?, ?, ?, ?, ?, '0.00', ?, now(), now(), ?)`,
    [
      row.id,
      row.providerId,
      row.externalTransactionId,
      row.idempotencyKey,
      'a'.repeat(64),
      row.walletId,
      row.playerId,
      row.kind,
      row.amount,
      row.currency,
      row.referenceExternalTransactionId,
      row.referenceTransactionId,
      row.status,
      row.failureCode,
      row.nextReferenceAttemptAt,
      row.processedAt,
    ],
  );
  return row;
}

export async function insertLedgerEntry(
  db: Connection,
  transaction: TransactionRow,
  overrides: Partial<LedgerRow> = {},
): Promise<LedgerRow> {
  const row: LedgerRow = {
    id: randomUUID(),
    walletId: transaction.walletId,
    transactionId: transaction.id,
    walletVersion: 2,
    direction: 'DEBIT',
    amount: '10.00',
    currency: transaction.currency,
    balanceBefore: '100.00',
    balanceAfter: '90.00',
    ...overrides,
  };
  await db.execute(
    `insert into wallet_ledger_entries (
       id, wallet_id, transaction_id, wallet_version, direction, amount, currency,
       balance_before, balance_after, created_at
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, now())`,
    [
      row.id,
      row.walletId,
      row.transactionId,
      row.walletVersion,
      row.direction,
      row.amount,
      row.currency,
      row.balanceBefore,
      row.balanceAfter,
    ],
  );
  return row;
}
