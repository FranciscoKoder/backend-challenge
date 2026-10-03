import { type Clock, systemClock } from '../shared/domain/clock';
import { type AppLogger, type Metrics, noopLogger, noopMetrics } from './observability';
import type { OutboxMessage } from '../messaging/domain/outbox-message';
import type { EventPublisher, UnitOfWork } from './ports';

export interface PublishBatchResult {
  published: number;
  failed: number;
}

/**
 * Publica eventos da outbox. Vários publishers (várias instâncias) podem rodar ao mesmo
 * tempo: `FOR UPDATE SKIP LOCKED` garante que cada mensagem seja reivindicada por apenas um.
 * Entrega é at-least-once: se o processo morrer entre `publish` e o COMMIT, a mensagem volta
 * à fila e é publicada de novo. Consumidores deduplicam por `eventId`.
 */
export class OutboxPublisherService {
  private readonly clock: Clock;
  private readonly metrics: Metrics;
  private readonly logger: AppLogger;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: EventPublisher,
    options: { clock?: Clock; metrics?: Metrics; logger?: AppLogger } = {},
  ) {
    this.clock = options.clock ?? systemClock;
    this.metrics = options.metrics ?? noopMetrics;
    this.logger = options.logger ?? noopLogger;
  }

  /**
   * Usa o envio em lote do publisher quando existe. Sem lote, publica um a um; depois do
   * primeiro erro de uma wallet, os eventos seguintes dela nem são tentados (`skipped`).
   */
  private async send(messages: OutboxMessage[]): Promise<{ failed: Map<string, string>; skipped: Set<string> }> {
    if (this.publisher.publishBatch) {
      return { failed: await this.publisher.publishBatch(messages), skipped: new Set() };
    }
    const failed = new Map<string, string>();
    const skipped = new Set<string>();
    const blocked = new Set<string>();
    for (const message of messages) {
      if (blocked.has(message.orderingKey)) {
        skipped.add(message.id);
        continue;
      }
      try {
        await this.publisher.publish(message);
      } catch (error) {
        failed.set(message.id, error instanceof Error ? error.message : String(error));
        blocked.add(message.orderingKey);
      }
    }
    return { failed, skipped };
  }

  async publishBatch(batchSize: number): Promise<PublishBatchResult> {
    return this.uow.run(async (repos) => {
      const now = this.clock.now();
      const due = await repos.outbox.lockDue(now, batchSize);
      if (due.length === 0) return { published: 0, failed: 0 };
      let published = 0;
      let failed = 0;

      const messages = due.map((d) => d.message);
      const result = await this.send(messages);

      for (const message of messages) {
        if (result.skipped.has(message.id)) continue; // segue pendente, atrás do anterior da wallet
        const error = result.failed.get(message.id);
        if (error === undefined) {
          // Falha daqui em diante é falha do banco: a transação inteira é desfeita e o evento
          // volta a ficar pendente (será publicado de novo, com o mesmo eventId).
          message.markPublished(this.clock.now());
          await repos.outbox.markPublished(message);
          this.metrics.outboxPublished(message.eventType);
          published += 1;
          continue;
        }
        // Retry com backoff. Os eventos seguintes da mesma wallet esperam por este:
        // o `lockDue` não os entrega enquanto houver um anterior em backoff.
        message.scheduleRetry(this.clock.now());
        await repos.outbox.recordFailure(message, error);
        this.metrics.outboxPublishFailure(message.eventType);
        this.metrics.retry('outbox_publish');
        this.logger.warn(
          { eventId: message.id, eventType: message.eventType, attempts: message.attempts },
          'falha ao publicar evento da outbox; retry agendado',
        );
        failed += 1;
      }
      return { published, failed };
    });
  }
}
