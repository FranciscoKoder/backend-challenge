/** Métricas de negócio emitidas pela camada de aplicação (a implementação real é Prometheus). */
export interface Metrics {
  transactionOutcome(kind: string, status: string): void;
  duplicateDetected(source: 'http' | 'sqs' | 'inbox'): void;
  idempotencyConflict(): void;
  retry(reason: 'db_conflict' | 'sqs_transient' | 'outbox_publish'): void;
  lockConflict(): void;
  walletLockWait(seconds: number): void;
  processingSeconds(source: 'http' | 'sqs' | 'pending', seconds: number): void;
  dlqMessage(reason: string): void;
  pendingReference(outcome: 'resolved' | 'rescheduled' | 'exhausted'): void;
  outboxPublished(eventType: string): void;
  outboxPublishFailure(eventType: string): void;
  reconciliationDivergence(): void;
}

export const METRICS = Symbol('METRICS');

export const noopMetrics: Metrics = {
  transactionOutcome: () => {},
  duplicateDetected: () => {},
  idempotencyConflict: () => {},
  retry: () => {},
  lockConflict: () => {},
  walletLockWait: () => {},
  processingSeconds: () => {},
  dlqMessage: () => {},
  pendingReference: () => {},
  outboxPublished: () => {},
  outboxPublishFailure: () => {},
  reconciliationDivergence: () => {},
};

/** Log estruturado. Nunca passe payloads financeiros completos aqui, apenas ids. */
export interface AppLogger {
  debug(fields: Record<string, unknown>, message: string): void;
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export const APP_LOGGER = Symbol('APP_LOGGER');

export const noopLogger: AppLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
