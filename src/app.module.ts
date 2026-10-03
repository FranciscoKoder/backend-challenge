import { Inject, Injectable, MiddlewareConsumer, Module, NestModule, OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import type { MikroORM } from '@mikro-orm/core';
import type { PostgreSqlDriver } from '@mikro-orm/postgresql';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { APP_LOGGER, type AppLogger, METRICS } from './application/observability';
import { OutboxPublisherService } from './application/outbox-publisher.service';
import { UNIT_OF_WORK } from './application/ports';
import { WagerProcessingService } from './application/wager-processing.service';
import { WalletService } from './application/wallet.service';
import { NoopAuthGuard } from './auth/auth.guard';
import { buildCore, type Core } from './composition';
import { CONFIG, type AppConfig, loadConfig } from './config/config';
import { correlationMiddleware } from './infrastructure/http/correlation.middleware';
import { ProblemExceptionFilter } from './infrastructure/http/exception.filter';
import { HealthController, MetricsController } from './infrastructure/http/health.controller';
import { WageringController } from './infrastructure/http/wagering.controller';
import { WalletsController } from './infrastructure/http/wallets.controller';
import { SqsEventPublisher } from './infrastructure/messaging/sqs-event-publisher';
import { createSqsClient } from './infrastructure/messaging/sqs-client';
import { PinoAppLogger, createPino } from './infrastructure/observability/logger';
import { PinoNestLogger } from './infrastructure/observability/nest-logger';
import { PromMetrics } from './infrastructure/observability/metrics';
import { createOrm } from './infrastructure/persistence/orm';
import { BackgroundRuntime, QueueUrlResolver } from './infrastructure/runtime';
import { CORE, ORM, SQS_CLIENT } from './infrastructure/tokens';

/** Fecha pool do banco e cliente SQS por último (depois de `beforeApplicationShutdown`). */
@Injectable()
class ResourceLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(ORM) private readonly orm: MikroORM<PostgreSqlDriver>,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    this.sqs.destroy();
    await this.orm.close(true);
  }
}

@Module({
  controllers: [WalletsController, WageringController, HealthController, MetricsController],
  providers: [
    { provide: CONFIG, useFactory: (): AppConfig => loadConfig() },
    {
      provide: APP_LOGGER,
      inject: [CONFIG],
      useFactory: (config: AppConfig): AppLogger => new PinoAppLogger(createPino(config.logLevel)),
    },
    { provide: METRICS, useFactory: () => new PromMetrics() },
    { provide: PromMetrics, useExisting: METRICS },
    {
      provide: ORM,
      inject: [CONFIG],
      useFactory: (config: AppConfig) => createOrm({ databaseUrl: config.databaseUrl, poolMax: config.dbPoolMax }),
    },
    { provide: SQS_CLIENT, inject: [CONFIG], useFactory: (config: AppConfig) => createSqsClient(config) },
    QueueUrlResolver,
    {
      provide: CORE,
      inject: [ORM, CONFIG, METRICS, APP_LOGGER, SQS_CLIENT, QueueUrlResolver],
      useFactory: (
        orm: MikroORM<PostgreSqlDriver>,
        config: AppConfig,
        metrics: PromMetrics,
        logger: AppLogger,
        sqs: SQSClient,
        queues: QueueUrlResolver,
      ): Core => {
        const core = buildCore({
          orm,
          pendingPolicy: {
            maxAttempts: config.pending.maxAttempts,
            baseDelayMs: config.pending.baseDelayMs,
            maxDelayMs: config.pending.maxDelayMs,
          },
          publisher: new SqsEventPublisher(sqs, async () => (await queues.urls()).events),
          metrics,
          logger,
        });
        metrics.bindOutboxStats(() => core.uow.read((repos) => repos.outbox.stats(new Date())));
        return core;
      },
    },
    { provide: UNIT_OF_WORK, inject: [CORE], useFactory: (core: Core) => core.uow },
    { provide: WagerProcessingService, inject: [CORE], useFactory: (core: Core) => core.wagering },
    { provide: WalletService, inject: [CORE], useFactory: (core: Core) => core.wallets },
    { provide: OutboxPublisherService, inject: [CORE], useFactory: (core: Core) => core.outbox },
    BackgroundRuntime,
    ResourceLifecycle,
    PinoNestLogger,
    ProblemExceptionFilter,
    { provide: APP_FILTER, useExisting: ProblemExceptionFilter },
    { provide: APP_GUARD, useClass: NoopAuthGuard },
  ],
})
export class AppModule implements NestModule {
  constructor(@Inject(APP_LOGGER) private readonly logger: AppLogger) {}

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(correlationMiddleware(this.logger)).forRoutes('*');
  }
}
