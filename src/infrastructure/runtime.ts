import { BeforeApplicationShutdown, Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { APP_LOGGER, type AppLogger, METRICS } from '../application/observability';
import { OutboxPublisherService } from '../application/outbox-publisher.service';
import { WagerProcessingService } from '../application/wager-processing.service';
import { CONFIG, type AppConfig } from '../config/config';
import { SqsTransactionConsumer } from './messaging/sqs-consumer';
import { type QueueUrls, ensureQueues, resolveQueueUrls } from './messaging/sqs-client';
import { WagerMessageHandler } from './messaging/wager-message-handler';
import type { PromMetrics } from './observability/metrics';
import { SQS_CLIENT } from './tokens';
import { PollingWorker } from './workers/polling-worker';

/** Resolve (e opcionalmente cria) as filas SQS uma única vez; compartilhado por publisher e consumer. */
@Injectable()
export class QueueUrlResolver {
  private pending?: Promise<QueueUrls>;

  constructor(
    @Inject(SQS_CLIENT) private readonly client: SQSClient,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  urls(): Promise<QueueUrls> {
    this.pending ??= (this.config.sqs.autoCreate
      ? ensureQueues(this.client, this.config)
      : resolveQueueUrls(this.client, this.config)
    ).catch((error) => {
      this.pending = undefined;
      throw error;
    });
    return this.pending;
  }
}

/**
 * Liga/desliga os papéis em segundo plano: consumidor SQS, publisher da outbox e worker de
 * PENDING_REFERENCE. Cada instância pode ligar qualquer combinação (ver `ENABLE_*`).
 * No shutdown: para de buscar mensagens, conclui o que está em andamento e só então o
 * pool do banco é fechado (hooks `onApplicationShutdown` rodam depois deste).
 */
@Injectable()
export class BackgroundRuntime implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private consumer?: SqsTransactionConsumer;
  private readonly workers: PollingWorker[] = [];

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(QueueUrlResolver) private readonly queues: QueueUrlResolver,
    @Inject(WagerProcessingService) private readonly wagering: WagerProcessingService,
    @Inject(OutboxPublisherService) private readonly outbox: OutboxPublisherService,
    @Inject(METRICS) private readonly metrics: PromMetrics,
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const { roles } = this.config;

    if (roles.outboxPublisher) {
      this.workers.push(
        new PollingWorker(
          'outbox-publisher',
          async () => {
            const { published, failed } = await this.outbox.publishBatch(this.config.outbox.batchSize);
            return published + failed > 0;
          },
          this.config.outbox.pollMs,
          this.logger,
        ),
      );
    }
    if (roles.pendingReferenceWorker) {
      this.workers.push(
        new PollingWorker(
          'pending-reference',
          () => this.wagering.reprocessNextPending(),
          this.config.pending.pollMs,
          this.logger,
        ),
      );
    }
    this.workers.forEach((w) => w.start());

    if (roles.sqsConsumer) {
      const urls = await this.queues.urls();
      const handler = new WagerMessageHandler(this.wagering, {
        maxReceiveCount: this.config.sqs.maxReceiveCount,
        retryBaseSeconds: this.config.sqs.retryBaseSeconds,
        metrics: this.metrics,
        logger: this.logger,
      });
      this.consumer = new SqsTransactionConsumer(
        this.sqs,
        handler,
        {
          queueUrl: urls.transactions,
          dlqUrl: urls.transactionsDlq,
          concurrency: this.config.sqs.consumerConcurrency,
          waitSeconds: this.config.sqs.waitSeconds,
          crashAfterCommit: this.config.faults.crashAfterCommit,
        },
        this.logger,
      );
      this.consumer.start();
    }
    this.logger.info({ roles }, 'aplicação iniciada');
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.logger.info({ signal }, 'shutdown: encerrando consumidor e workers');
    await this.consumer?.stop();
    await Promise.all(this.workers.map((w) => w.stop()));
    this.logger.info({}, 'shutdown: consumidor e workers encerrados');
  }
}
