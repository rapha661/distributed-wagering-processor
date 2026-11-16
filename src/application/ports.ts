import type { WalletLedgerEntry } from '../domain/ledger/wallet-ledger-entry';
import type { OutboxMessage } from '../domain/messaging/outbox-message';
import type { WagerTransaction } from '../domain/wagering/wager-transaction';
import type { Wallet } from '../domain/wallet/wallet';
import type { LedgerEntryView, ReconciliationSnapshot, TransactionView, WalletView } from './views';

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

export interface WalletRepository {
  /** Carrega a wallet travando a linha até o fim da transação (SELECT ... FOR UPDATE). */
  lockById(id: string): Promise<Wallet | undefined>;
  add(wallet: Wallet): void;
  /** Registra o novo saldo e versão de uma wallet carregada por `lockById`. */
  update(wallet: Wallet): void;
}

export interface WagerTransactionRepository {
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** Se já existe REFUND ou ROLLBACK processado revertendo a transação. */
  hasProcessedReversal(transactionId: string): Promise<boolean>;
  /**
   * Trava a próxima transação PENDING_REFERENCE vencida (FOR UPDATE SKIP LOCKED):
   * workers concorrentes nunca pegam a mesma.
   */
  lockNextDuePendingReference(now: Date): Promise<WagerTransaction | undefined>;
  add(transaction: WagerTransaction): void;
  /** Registra a transição de uma transação carregada por `lockNextDuePendingReference`. */
  update(transaction: WagerTransaction): void;
}

export interface LedgerRepository {
  add(entry: WalletLedgerEntry): void;
}

export interface OutboxRepository {
  add(message: OutboxMessage): void;
  /** Trava um lote de mensagens pendentes e vencidas (FOR UPDATE SKIP LOCKED), das mais antigas para as mais novas. */
  claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  /** Registra publicação ou nova tentativa de uma mensagem carregada por `claimDue`. */
  update(message: OutboxMessage): void;
}

export interface PublishResult {
  published: string[];
  failed: string[];
}

export interface EventPublisher {
  /** Publica as mensagens e informa, por id, quais foram aceitas pelo broker. Não lança. */
  publish(messages: readonly OutboxMessage[]): Promise<PublishResult>;
}

export interface TransactionalRepositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  outbox: OutboxRepository;
}

export interface UnitOfWork {
  /**
   * Executa `work` numa única transação SQL. Tudo o que for registrado nos repositórios
   * é gravado junto no commit, ou nada é.
   */
  run<T>(work: (repositories: TransactionalRepositories) => Promise<T>): Promise<T>;
}

export interface WageringQueries {
  getWallet(walletId: string): Promise<WalletView | undefined>;
  /** Lançamentos do mais novo para o mais antigo; undefined se a wallet não existe. */
  getLedger(walletId: string, page: { beforeVersion?: number; limit: number }): Promise<LedgerEntryView[] | undefined>;
  getTransaction(transactionId: string): Promise<TransactionView | undefined>;
  getTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView | undefined>;
  /** Saldo gravado e somatório do ledger, lidos num único snapshot. */
  getReconciliationSnapshot(walletId: string): Promise<ReconciliationSnapshot | undefined>;
}

export interface ReconciliationObserver {
  mismatch(report: { walletId: string; difference: string; checkedEntries: number }): void;
}
