import type { AppLogger } from '../../application/observability';

/**
 * Loop de polling genérico. `tick` devolve `true` se fez trabalho (então roda de novo sem
 * dormir) e `false` quando está ocioso. Erros nunca derrubam o loop: viram log + backoff.
 */
export class PollingWorker {
  private stopping = false;
  private loop?: Promise<void>;
  private wake?: () => void;

  constructor(
    private readonly name: string,
    private readonly tick: () => Promise<boolean>,
    private readonly idleMs: number,
    private readonly logger: AppLogger,
  ) {}

  start(): void {
    if (this.loop) return;
    this.loop = this.run();
  }

  /** Para o loop e espera a iteração corrente terminar. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    let consecutiveErrors = 0;
    while (!this.stopping) {
      let didWork = false;
      try {
        didWork = await this.tick();
        consecutiveErrors = 0;
      } catch (error) {
        consecutiveErrors += 1;
        this.logger.error({ worker: this.name, error: String(error), consecutiveErrors }, 'falha no ciclo do worker');
      }
      if (didWork || this.stopping) continue;
      const delay = consecutiveErrors > 0 ? Math.min(10_000, this.idleMs * 2 ** consecutiveErrors) : this.idleMs;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }
}
