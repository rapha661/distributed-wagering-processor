import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1).default('postgres://wagering:wagering@localhost:5432/wagering'),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(20),
  DATABASE_LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  REFERENCE_RETRY_BASE_MS: z.coerce.number().int().positive().default(2_000),
  REFERENCE_RETRY_MAX_MS: z.coerce.number().int().positive().default(300_000),
  REFERENCE_RETRY_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),
  AWS_REGION: z.string().min(1).default('us-east-1'),
  AWS_ENDPOINT_URL: z.string().min(1).default('http://localhost:4566'),
  AWS_ACCESS_KEY_ID: z.string().min(1).default('test'),
  AWS_SECRET_ACCESS_KEY: z.string().min(1).default('test'),
  SQS_WAGER_QUEUE: z.string().min(1).default('wager-transactions.fifo'),
  SQS_WAGER_DLQ: z.string().min(1).default('wager-transactions-dlq.fifo'),
  SQS_EVENTS_QUEUE: z.string().min(1).default('wallet-events.fifo'),
});

export type AppConfig = z.infer<typeof schema>;

export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  return schema.parse(env);
}
