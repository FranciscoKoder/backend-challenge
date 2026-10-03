import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response('ok') });
  const port = server.port as number;
  await server.stop(true);
  return port;
}

export interface AppProcessOptions {
  databaseUrl: string;
  /** Variáveis de ambiente das filas (de `createTestQueues().env`). */
  queueEnv: Record<string, string>;
  /** Papéis desta instância; por padrão tudo ligado. */
  roles?: { sqsConsumer?: boolean; outboxPublisher?: boolean; pendingReferenceWorker?: boolean };
  env?: Record<string, string>;
}

/** Uma instância real da aplicação (processo `bun` separado) falando com o mesmo PostgreSQL/SQS. */
export class AppProcess {
  readonly logs: string[] = [];
  exited?: Promise<number>;

  private constructor(
    readonly port: number,
    private readonly proc: ReturnType<typeof Bun.spawn>,
  ) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  static async start(options: AppProcessOptions): Promise<AppProcess> {
    const port = await freePort();
    const roles = options.roles ?? {};
    const proc = Bun.spawn([process.execPath, 'run', 'src/main.ts'], {
      cwd: ROOT,
      env: {
        ...(process.env as Record<string, string>),
        ...options.queueEnv,
        DATABASE_URL: options.databaseUrl,
        PORT: String(port),
        LOG_LEVEL: 'info',
        DB_POOL_MAX: '10',
        ENABLE_SQS_CONSUMER: String(roles.sqsConsumer ?? true),
        ENABLE_OUTBOX_PUBLISHER: String(roles.outboxPublisher ?? true),
        ENABLE_PENDING_REFERENCE_WORKER: String(roles.pendingReferenceWorker ?? true),
        OUTBOX_POLL_MS: '100',
        PENDING_POLL_MS: '100',
        PENDING_BASE_DELAY_MS: '200',
        PENDING_MAX_DELAY_MS: '1000',
        ...options.env,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const app = new AppProcess(port, proc);
    app.exited = proc.exited;
    app.collect(proc.stdout as ReadableStream<Uint8Array>);
    app.collect(proc.stderr as ReadableStream<Uint8Array>);
    await app.waitReady();
    return app;
  }

  private collect(stream: ReadableStream<Uint8Array>): void {
    const decoder = new TextDecoder();
    void (async () => {
      let buffer = '';
      for await (const chunk of stream) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        this.logs.push(...lines);
      }
    })().catch(() => {});
  }

  private async waitReady(): Promise<void> {
    const deadline = Date.now() + 40_000;
    for (;;) {
      if (this.proc.exitCode !== null) {
        throw new Error(`processo encerrou antes de ficar pronto (código ${this.proc.exitCode}):\n${this.logs.slice(-20).join('\n')}`);
      }
      try {
        const res = await fetch(`${this.url}/health/ready`);
        if (res.status === 200) return;
      } catch {
        /* ainda subindo */
      }
      if (Date.now() > deadline) throw new Error(`timeout esperando a app subir:\n${this.logs.slice(-20).join('\n')}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${this.url}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, body: json, headers: res.headers };
  }

  /** Encerramento limpo (SIGTERM). Devolve o código de saída. */
  async stop(signal: NodeJS.Signals = 'SIGTERM'): Promise<number> {
    if (this.proc.exitCode === null) this.proc.kill(signal);
    return this.proc.exited;
  }

  /** Morte abrupta, sem hooks de shutdown (simula crash). */
  async kill(): Promise<void> {
    if (this.proc.exitCode === null) this.proc.kill('SIGKILL');
    await this.proc.exited;
  }

  get hasExited(): boolean {
    return this.proc.exitCode !== null;
  }
}
