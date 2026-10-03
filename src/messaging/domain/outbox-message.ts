import { InvalidTransactionStateError } from '../../shared/domain/errors';
import type { IntegrationEvent } from '../../shared/domain/integration-event';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;

/** Mensagem de integração gravada na mesma transação SQL do fato financeiro. */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  /** O `id` da outbox é o `eventId`: consumidores deduplicam por ele. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.toJSON() as unknown as Record<string, unknown>,
      event.occurredAt,
      0,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  /**
   * Chave de ordenação/agrupamento (FIFO MessageGroupId): a wallet do evento, quando houver.
   * Eventos da mesma wallet são publicados em ordem; wallets diferentes são independentes.
   */
  get orderingKey(): string {
    const data = (this.payload as { data?: { walletId?: unknown } }).data;
    return typeof data?.walletId === 'string' ? data.walletId : this.aggregateId;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new InvalidTransactionStateError(`Evento ${this.id} já foi publicado`);
    }
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  /** Incrementa `attempts` e calcula o próximo `nextAttemptAt` (backoff exponencial limitado). */
  scheduleRetry(now: Date): void {
    if (!this.isPending()) {
      throw new InvalidTransactionStateError(`Evento ${this.id} já foi publicado`);
    }
    this._attempts += 1;
    const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (this._attempts - 1));
    this._nextAttemptAt = new Date(now.getTime() + delay);
  }
}
