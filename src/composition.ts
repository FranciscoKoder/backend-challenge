import type { MikroORM } from '@mikro-orm/core';
import type { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { OutboxPublisherService } from './application/outbox-publisher.service';
import type { AppLogger, Metrics } from './application/observability';
import type { EventPublisher, UnitOfWork } from './application/ports';
import { WagerProcessingService } from './application/wager-processing.service';
import { WalletService } from './application/wallet.service';
import type { Clock } from './shared/domain/clock';
import type { PendingReferencePolicy } from './wagering/domain/wager-transaction';
import { MikroUnitOfWork } from './infrastructure/persistence/mikro-unit-of-work';

export interface CoreDependencies {
  orm: MikroORM<PostgreSqlDriver>;
  pendingPolicy: PendingReferencePolicy;
  publisher: EventPublisher;
  metrics?: Metrics;
  logger?: AppLogger;
  clock?: Clock;
}

export interface Core {
  uow: UnitOfWork;
  wagering: WagerProcessingService;
  wallets: WalletService;
  outbox: OutboxPublisherService;
}

/** Monta os serviços de aplicação sem depender do Nest (usado pelo Nest e pelos testes). */
export function buildCore(deps: CoreDependencies): Core {
  const uow = new MikroUnitOfWork(deps.orm);
  const shared = { clock: deps.clock, metrics: deps.metrics, logger: deps.logger };
  return {
    uow,
    wagering: new WagerProcessingService(uow, { pendingPolicy: deps.pendingPolicy, ...shared }),
    wallets: new WalletService(uow, shared),
    outbox: new OutboxPublisherService(uow, deps.publisher, shared),
  };
}
