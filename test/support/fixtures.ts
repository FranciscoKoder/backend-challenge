import type { MikroORM } from '@mikro-orm/core';
import type { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { buildCore, type Core } from '../../src/composition';
import { WagerProcessingService, type SubmitContext } from '../../src/application/wager-processing.service';
import { WalletService } from '../../src/application/wallet.service';
import { OutboxPublisherService } from '../../src/application/outbox-publisher.service';
import type { Metrics } from '../../src/application/observability';
import type { EventPublisher, Repositories, UnitOfWork } from '../../src/application/ports';
import type { SubmitWagerCommand } from '../../src/application/wager-command';
import { createOrm } from '../../src/infrastructure/persistence/orm';
import type { Clock } from '../../src/shared/domain/clock';
import { Money } from '../../src/shared/domain/money';
import { uuidv7 } from '../../src/shared/domain/uuid';
import { WagerTransactionKind } from '../../src/wagering/domain/wager-transaction';

export const POLICY = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 };

export const memoryPublisher = (): EventPublisher & { published: any[] } => {
  const published: any[] = [];
  return {
    published,
    async publish(message) {
      published.push(message.payload);
    },
  };
};

/** Relógio controlável para testes determinísticos de backoff. */
export class FakeClock implements Clock {
  constructor(private current = new Date()) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export interface TestApp {
  orm: MikroORM<PostgreSqlDriver>;
  core: Core;
  close(): Promise<void>;
}

export interface TestAppOptions {
  publisher?: EventPublisher;
  poolMax?: number;
  clock?: Clock;
  metrics?: Metrics;
  /** Decora o UnitOfWork (injeção de falhas). */
  wrapUow?: (uow: UnitOfWork) => UnitOfWork;
}

/** Uma "instância" da aplicação (pool próprio) contra o banco de teste. */
export async function startTestApp(databaseUrl: string, options: TestAppOptions = {}): Promise<TestApp> {
  const orm = await createOrm({ databaseUrl, poolMax: options.poolMax ?? 10 });
  const publisher = options.publisher ?? memoryPublisher();
  let core = buildCore({
    orm,
    pendingPolicy: POLICY,
    publisher,
    clock: options.clock,
    metrics: options.metrics,
  });
  if (options.wrapUow) {
    const uow = options.wrapUow(core.uow);
    const shared = { clock: options.clock, metrics: options.metrics };
    core = {
      uow,
      wagering: new WagerProcessingService(uow, { pendingPolicy: POLICY, ...shared }),
      wallets: new WalletService(uow, shared),
      outbox: new OutboxPublisherService(uow, publisher, shared),
    };
  }
  return { orm, core, close: () => orm.close(true) };
}

/** Faz o `enqueue` da outbox falhar na N-ésima chamada: simula queda no meio da transação. */
export function failingUow(inner: UnitOfWork, shouldFail: () => boolean): UnitOfWork {
  const wrap = (repos: Repositories): Repositories => ({
    ...repos,
    outbox: {
      ...repos.outbox,
      enqueue: async (message) => {
        if (shouldFail()) throw new Error('falha injetada na outbox');
        return repos.outbox.enqueue(message);
      },
      lockDue: (now, limit) => repos.outbox.lockDue(now, limit),
      markPublished: (m) => repos.outbox.markPublished(m),
      recordFailure: (m, e) => repos.outbox.recordFailure(m, e),
      stats: (now) => repos.outbox.stats(now),
    },
  });
  return {
    run: (work) => inner.run((repos) => work(wrap(repos))),
    read: (work) => inner.read((repos) => work(wrap(repos))),
  };
}

export const httpCtx = (correlationId = uuidv7()): SubmitContext => ({ correlationId, source: 'http' });

export function command(
  overrides: Partial<SubmitWagerCommand> & { walletId: string; playerId: string },
): SubmitWagerCommand {
  const externalTransactionId = overrides.externalTransactionId ?? `tx-${uuidv7()}`;
  const providerId = overrides.providerId ?? 'provider-a';
  return {
    providerId,
    externalTransactionId,
    idempotencyKey: `${providerId}:${externalTransactionId}`,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: '25.00', currency: 'BRL' }),
    ...overrides,
  };
}

export async function createWallet(app: TestApp, initial = '1000.00', playerId = uuidv7()) {
  const wallet = await app.core.wallets.create(
    { playerId, initialBalance: Money.from({ amount: initial, currency: 'BRL' }) },
    'test',
  );
  return { walletId: wallet.id, playerId };
}

export const money = (amount: string, currency = 'BRL') => Money.from({ amount, currency });

/** Sobrescreve métodos de um objeto (instância de classe) preservando os demais. */
export function withOverrides<T extends object>(target: T, overrides: Partial<T>): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop in overrides) return (overrides as Record<PropertyKey, unknown>)[prop];
      const value = Reflect.get(obj, prop, receiver);
      return typeof value === 'function' ? value.bind(obj) : value;
    },
  });
}
