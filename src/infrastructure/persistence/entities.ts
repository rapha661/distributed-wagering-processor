import { defineEntity, type InferEntity, p } from '@mikro-orm/postgresql';

// Registros de persistência. O domínio não conhece estas definições: os mappers
// convertem nos dois sentidos e reidratam o domínio com `rehydrate`.

export const WalletEntity = defineEntity({
  name: 'WalletRecord',
  tableName: 'wallets',
  properties: {
    id: p.uuid().primary(),
    playerId: p.uuid(),
    currency: p.string().columnType('char(3)'),
    balance: p.decimal().columnType('numeric(20,2)'),
    version: p.integer(),
    createdAt: p.datetime().columnType('timestamptz'),
    updatedAt: p.datetime().columnType('timestamptz'),
  },
});

export const WagerTransactionEntity = defineEntity({
  name: 'WagerTransactionRecord',
  tableName: 'wager_transactions',
  properties: {
    id: p.uuid().primary(),
    providerId: p.string(),
    externalTransactionId: p.string(),
    idempotencyKey: p.string(),
    payloadHash: p.string().columnType('char(64)'),
    // relação só para o Unit of Work inserir na ordem das FKs; a propriedade guarda o id
    walletId: () => p.manyToOne(WalletEntity).mapToPk().joinColumn('wallet_id'),
    playerId: p.uuid(),
    roundId: p.string(),
    gameId: p.string(),
    kind: p.string(),
    amount: p.decimal().columnType('numeric(20,2)'),
    currency: p.string().columnType('char(3)'),
    referenceExternalTransactionId: p.string().nullable(),
    referenceTransactionId: p.uuid().nullable(),
    status: p.string(),
    failureCode: p.string().nullable(),
    observedBalance: p.decimal().columnType('numeric(20,2)').nullable(),
    referenceAttempts: p.integer(),
    nextReferenceAttemptAt: p.datetime().columnType('timestamptz').nullable(),
    createdAt: p.datetime().columnType('timestamptz'),
    updatedAt: p.datetime().columnType('timestamptz'),
    processedAt: p.datetime().columnType('timestamptz').nullable(),
  },
});

export const LedgerEntryEntity = defineEntity({
  name: 'LedgerEntryRecord',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: p.uuid().primary(),
    walletId: () => p.manyToOne(WalletEntity).mapToPk().joinColumn('wallet_id'),
    transactionId: () => p.manyToOne(WagerTransactionEntity).mapToPk().joinColumn('transaction_id'),
    walletVersion: p.integer(),
    direction: p.string(),
    amount: p.decimal().columnType('numeric(20,2)'),
    currency: p.string().columnType('char(3)'),
    balanceBefore: p.decimal().columnType('numeric(20,2)'),
    balanceAfter: p.decimal().columnType('numeric(20,2)'),
    createdAt: p.datetime().columnType('timestamptz'),
  },
});

export const InboxEntity = defineEntity({
  name: 'InboxRecord',
  tableName: 'inbox_messages',
  properties: {
    consumerName: p.string().primary(),
    messageId: p.string().primary(),
    payloadHash: p.string().columnType('char(64)'),
    receivedAt: p.datetime().columnType('timestamptz'),
    processedAt: p.datetime().columnType('timestamptz').nullable(),
  },
  primaryKeys: ['consumerName', 'messageId'],
});

export const OutboxEntity = defineEntity({
  name: 'OutboxRecord',
  tableName: 'outbox_messages',
  properties: {
    id: p.uuid().primary(),
    aggregateId: p.uuid(),
    eventType: p.string(),
    payload: p.json<Record<string, unknown>>(),
    occurredAt: p.datetime().columnType('timestamptz'),
    attempts: p.integer(),
    nextAttemptAt: p.datetime().columnType('timestamptz'),
    publishedAt: p.datetime().columnType('timestamptz').nullable(),
  },
});

export const ENTITIES = [WalletEntity, WagerTransactionEntity, LedgerEntryEntity, InboxEntity, OutboxEntity];

export type WalletRecord = InferEntity<typeof WalletEntity>;
export type WagerTransactionRecord = InferEntity<typeof WagerTransactionEntity>;
export type LedgerEntryRecord = InferEntity<typeof LedgerEntryEntity>;
export type InboxRecord = InferEntity<typeof InboxEntity>;
export type OutboxRecord = InferEntity<typeof OutboxEntity>;
