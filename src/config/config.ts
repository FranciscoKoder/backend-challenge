import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1).default('postgres://postgres:postgres@localhost:5432/wagering'),
  DB_POOL_MAX: z.coerce.number().int().min(1).default(20),

  AWS_REGION: z.string().default('us-east-1'),
  AWS_ENDPOINT_URL: z.string().optional(),
  SQS_QUEUE_PREFIX: z.string().default(''),
  SQS_AUTO_CREATE: bool.default('true'),
  SQS_MAX_RECEIVE_COUNT: z.coerce.number().int().min(1).default(5),
  SQS_CONSUMER_CONCURRENCY: z.coerce.number().int().min(1).default(10),
  SQS_WAIT_SECONDS: z.coerce.number().int().min(0).max(20).default(5),
  SQS_VISIBILITY_TIMEOUT: z.coerce.number().int().min(1).default(30),
  SQS_RETRY_BASE_SECONDS: z.coerce.number().int().min(0).default(2),

  ENABLE_SQS_CONSUMER: bool.default('true'),
  ENABLE_OUTBOX_PUBLISHER: bool.default('true'),
  ENABLE_PENDING_REFERENCE_WORKER: bool.default('true'),

  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).default(50),
  OUTBOX_POLL_MS: z.coerce.number().int().min(10).default(500),

  PENDING_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(8),
  PENDING_BASE_DELAY_MS: z.coerce.number().int().min(1).default(5_000),
  PENDING_MAX_DELAY_MS: z.coerce.number().int().min(1).default(300_000),
  PENDING_POLL_MS: z.coerce.number().int().min(10).default(1_000),
  PENDING_BATCH_SIZE: z.coerce.number().int().min(1).default(50),

  FAULT_CRASH_AFTER_COMMIT: bool.default('false'),
});

export interface AppConfig {
  port: number;
  logLevel: string;
  databaseUrl: string;
  dbPoolMax: number;
  aws: { region: string; endpoint?: string };
  sqs: {
    queuePrefix: string;
    autoCreate: boolean;
    maxReceiveCount: number;
    consumerConcurrency: number;
    waitSeconds: number;
    visibilityTimeout: number;
    retryBaseSeconds: number;
    queues: { transactions: string; transactionsDlq: string; events: string };
  };
  roles: { sqsConsumer: boolean; outboxPublisher: boolean; pendingReferenceWorker: boolean };
  outbox: { batchSize: number; pollMs: number };
  pending: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number; pollMs: number; batchSize: number };
  faults: { crashAfterCommit: boolean };
}

export const CONFIG = Symbol('CONFIG');

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const e = schema.parse(env);
  const prefix = e.SQS_QUEUE_PREFIX;
  return {
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    dbPoolMax: e.DB_POOL_MAX,
    aws: { region: e.AWS_REGION, endpoint: e.AWS_ENDPOINT_URL },
    sqs: {
      queuePrefix: prefix,
      autoCreate: e.SQS_AUTO_CREATE,
      maxReceiveCount: e.SQS_MAX_RECEIVE_COUNT,
      consumerConcurrency: e.SQS_CONSUMER_CONCURRENCY,
      waitSeconds: e.SQS_WAIT_SECONDS,
      visibilityTimeout: e.SQS_VISIBILITY_TIMEOUT,
      retryBaseSeconds: e.SQS_RETRY_BASE_SECONDS,
      queues: {
        transactions: `${prefix}wager-transactions.fifo`,
        transactionsDlq: `${prefix}wager-transactions-dlq.fifo`,
        events: `${prefix}wager-events.fifo`,
      },
    },
    roles: {
      sqsConsumer: e.ENABLE_SQS_CONSUMER,
      outboxPublisher: e.ENABLE_OUTBOX_PUBLISHER,
      pendingReferenceWorker: e.ENABLE_PENDING_REFERENCE_WORKER,
    },
    outbox: { batchSize: e.OUTBOX_BATCH_SIZE, pollMs: e.OUTBOX_POLL_MS },
    pending: {
      maxAttempts: e.PENDING_MAX_ATTEMPTS,
      baseDelayMs: e.PENDING_BASE_DELAY_MS,
      maxDelayMs: e.PENDING_MAX_DELAY_MS,
      pollMs: e.PENDING_POLL_MS,
      batchSize: e.PENDING_BATCH_SIZE,
    },
    faults: { crashAfterCommit: e.FAULT_CRASH_AFTER_COMMIT },
  };
}
