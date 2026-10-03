import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { Metrics } from '../../application/observability';

export interface OutboxStatsProvider {
  (): Promise<{ pending: number; oldestAgeSeconds: number }>;
}

/** Métricas Prometheus. Registry próprio (não global) para permitir várias instâncias em testes. */
export class PromMetrics implements Metrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: 'wager_transactions_total',
    help: 'Transações processadas, por tipo e status final',
    labelNames: ['kind', 'status'],
    registers: [this.registry],
  });
  private readonly duplicates = new Counter({
    name: 'wager_duplicates_detected_total',
    help: 'Duplicatas detectadas (replay de idempotência ou mensagem repetida na inbox)',
    labelNames: ['source'],
    registers: [this.registry],
  });
  private readonly conflicts = new Counter({
    name: 'wager_idempotency_conflicts_total',
    help: 'Mesma Idempotency-Key com payload diferente',
    registers: [this.registry],
  });
  private readonly retries = new Counter({
    name: 'wager_retries_total',
    help: 'Retries por motivo',
    labelNames: ['reason'],
    registers: [this.registry],
  });
  private readonly lockConflicts = new Counter({
    name: 'wallet_lock_conflicts_total',
    help: 'Disputas por lock de wallet: espera acima de 50ms ou deadlock/conflito refeito',
    registers: [this.registry],
  });
  private readonly lockWait = new Histogram({
    name: 'wallet_lock_wait_seconds',
    help: 'Tempo esperando o lock da linha da wallet',
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });
  private readonly processing = new Histogram({
    name: 'wager_processing_duration_seconds',
    help: 'Latência de processamento de ponta a ponta',
    labelNames: ['source'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });
  private readonly dlq = new Counter({
    name: 'sqs_dlq_messages_total',
    help: 'Mensagens enviadas à DLQ',
    labelNames: ['reason'],
    registers: [this.registry],
  });
  private readonly pendingRef = new Counter({
    name: 'wager_pending_reference_total',
    help: 'Reprocessamentos de PENDING_REFERENCE por resultado',
    labelNames: ['outcome'],
    registers: [this.registry],
  });
  private readonly outboxPublishedTotal = new Counter({
    name: 'outbox_published_total',
    help: 'Eventos publicados pela outbox',
    labelNames: ['event_type'],
    registers: [this.registry],
  });
  private readonly outboxFailures = new Counter({
    name: 'outbox_publish_failures_total',
    help: 'Falhas ao publicar eventos da outbox',
    labelNames: ['event_type'],
    registers: [this.registry],
  });
  private readonly divergences = new Counter({
    name: 'reconciliation_divergences_total',
    help: 'Reconciliações que encontraram saldo diferente do ledger',
    registers: [this.registry],
  });
  private outboxStats?: OutboxStatsProvider;
  private statsInFlight?: Promise<{ pending: number; oldestAgeSeconds: number } | undefined>;

  /** Um único SELECT por scrape, compartilhado pelos dois gauges. */
  private readStats(): Promise<{ pending: number; oldestAgeSeconds: number } | undefined> {
    if (!this.outboxStats) return Promise.resolve(undefined);
    this.statsInFlight ??= this.outboxStats()
      .catch(() => undefined)
      .finally(() => setTimeout(() => (this.statsInFlight = undefined), 250));
    return this.statsInFlight;
  }

  private readonly outboxPending = new Gauge({
    name: 'outbox_pending_messages',
    help: 'Eventos aguardando publicação',
    registers: [this.registry],
    collect: async () => {
      const stats = await this.readStats();
      if (stats) this.outboxPending.set(stats.pending);
    },
  });
  private readonly outboxLag = new Gauge({
    name: 'outbox_lag_seconds',
    help: 'Idade do evento pendente mais antigo (lag da outbox)',
    registers: [this.registry],
    collect: async () => {
      const stats = await this.readStats();
      if (stats) this.outboxLag.set(stats.oldestAgeSeconds);
    },
  });

  constructor(options: { defaultMetrics?: boolean } = {}) {
    if (options.defaultMetrics !== false) collectDefaultMetrics({ register: this.registry });
  }

  /** Os gauges da outbox são calculados no momento do scrape. */
  bindOutboxStats(provider: OutboxStatsProvider): void {
    this.outboxStats = provider;
  }

  transactionOutcome(kind: string, status: string): void {
    this.transactions.inc({ kind, status });
  }
  duplicateDetected(source: 'http' | 'sqs' | 'inbox'): void {
    this.duplicates.inc({ source });
  }
  idempotencyConflict(): void {
    this.conflicts.inc();
  }
  retry(reason: string): void {
    this.retries.inc({ reason });
  }
  lockConflict(): void {
    this.lockConflicts.inc();
  }
  walletLockWait(seconds: number): void {
    this.lockWait.observe(seconds);
  }
  processingSeconds(source: 'http' | 'sqs' | 'pending', seconds: number): void {
    this.processing.observe({ source }, seconds);
  }
  dlqMessage(reason: string): void {
    this.dlq.inc({ reason });
  }
  pendingReference(outcome: 'resolved' | 'rescheduled' | 'exhausted'): void {
    this.pendingRef.inc({ outcome });
  }
  outboxPublished(eventType: string): void {
    this.outboxPublishedTotal.inc({ event_type: eventType });
  }
  outboxPublishFailure(eventType: string): void {
    this.outboxFailures.inc({ event_type: eventType });
  }
  reconciliationDivergence(): void {
    this.divergences.inc();
  }
}
