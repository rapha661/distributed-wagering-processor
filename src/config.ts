import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  /** api: só HTTP · worker: HTTP de health + workers · all: tudo (padrão local) */
  APP_ROLE: z.enum(['api', 'worker', 'all']).default('all'),
  DATABASE_URL: z.string().min(1).default('postgres://wagering:wagering@localhost:5432/wagering'),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(20),
  DATABASE_LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  DATABASE_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  REFERENCE_RETRY_BASE_MS: z.coerce.number().int().positive().default(2_000),
  REFERENCE_RETRY_MAX_MS: z.coerce.number().int().positive().default(300_000),
  REFERENCE_RETRY_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),
  PENDING_REFERENCE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),
  PENDING_REFERENCE_BATCH_SIZE: z.coerce.number().int().positive().default(50),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().default(50),
  SQS_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  AWS_REGION: z.string().min(1).default('us-east-1'),
  AWS_ENDPOINT_URL: z.string().min(1).default('http://localhost:4566'),
  AWS_ACCESS_KEY_ID: z.string().min(1).default('test'),
  AWS_SECRET_ACCESS_KEY: z.string().min(1).default('test'),
  SQS_WAGER_QUEUE: z.string().min(1).default('wager-transactions.fifo'),
  SQS_WAGER_DLQ: z.string().min(1).default('wager-transactions-dlq.fifo'),
  SQS_EVENTS_QUEUE: z.string().min(1).default('wallet-events.fifo'),
  SQS_CONSUMER_BATCH_SIZE: z.coerce.number().int().min(1).max(10).default(10),
  SQS_CONSUMER_WAIT_SECONDS: z.coerce.number().int().min(0).max(20).default(5),
  /** tentativas antes da DLQ; não deve passar do maxReceiveCount do redrive da fila */
  SQS_CONSUMER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  SQS_CONSUMER_RETRY_BASE_MS: z.coerce.number().int().positive().default(2_000),
  SQS_CONSUMER_RETRY_MAX_MS: z.coerce.number().int().positive().default(60_000),
  /** só para testes de queda com processos reais */
  FAULT_INJECTION: z.enum(['crash-after-commit']).optional(),
});

export type AppConfig = z.infer<typeof schema>;

export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  return schema.parse(env);
}
