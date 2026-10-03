import { Controller, Get, Inject, Res } from '@nestjs/common';
import { GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { Response } from 'express';
import { type UnitOfWork, UNIT_OF_WORK } from '../../application/ports';
import { CONFIG, type AppConfig } from '../../config/config';
import { PromMetrics } from '../observability/metrics';
import { SQS_CLIENT } from '../tokens';

@Controller()
export class HealthController {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** Liveness: o processo está de pé. Não toca em dependências. */
  @Get('health/live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: PostgreSQL e SQS alcançáveis. Sem autenticação. */
  @Get('health/ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const [database, queue] = await Promise.all([
      this.check(() => this.uow.read(async (repos) => void (await repos.wallets.findById('00000000-0000-0000-0000-000000000000')))),
      this.check(() => this.sqs.send(new GetQueueUrlCommand({ QueueName: this.config.sqs.queues.transactions }))),
    ]);
    const ok = database === 'up' && queue === 'up';
    res.status(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'unavailable', checks: { postgres: database, sqs: queue } };
  }

  private async check(probe: () => Promise<unknown>): Promise<'up' | 'down'> {
    try {
      await Promise.race([
        probe(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
      ]);
      return 'up';
    } catch {
      return 'down';
    }
  }
}

@Controller()
export class MetricsController {
  constructor(@Inject(PromMetrics) private readonly metrics: PromMetrics) {}

  @Get('metrics')
  async scrape(@Res() res: Response) {
    res.setHeader('Content-Type', this.metrics.registry.contentType);
    res.send(await this.metrics.registry.metrics());
  }
}
