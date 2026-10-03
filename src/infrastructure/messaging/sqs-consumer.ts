import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { AppLogger } from '../../application/observability';
import { logContext } from '../observability/logger';
import type { Disposition, WagerMessageHandler } from './wager-message-handler';

export interface ConsumerOptions {
  queueUrl: string;
  dlqUrl: string;
  concurrency: number;
  waitSeconds: number;
  /** Teste de falha: encerra o processo depois do COMMIT e antes do ack (DeleteMessage). */
  crashAfterCommit: boolean;
  /** Tempo máximo esperando mensagens em andamento no shutdown. */
  drainTimeoutMs?: number;
}

/**
 * Consumidor SQS (long polling). Garantias:
 *  - `DeleteMessage` (ack) só roda depois que o handler terminou, ou seja, depois do COMMIT;
 *  - no máximo `concurrency` mensagens em andamento;
 *  - em shutdown: para de buscar, conclui o que está em andamento e devolve a visibilidade
 *    do que não conseguiu terminar.
 */
export class SqsTransactionConsumer {
  private stopping = false;
  private loop?: Promise<void>;
  private abort?: AbortController;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly receipts = new Map<string, string>();

  constructor(
    private readonly client: SQSClient,
    private readonly handler: WagerMessageHandler,
    private readonly options: ConsumerOptions,
    private readonly logger: AppLogger,
  ) {}

  start(): void {
    if (this.loop) return;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.abort?.abort(); // interrompe o long poll em andamento
    await this.loop;
    const drain = Promise.allSettled([...this.inFlight]);
    const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), this.options.drainTimeoutMs ?? 25_000));
    if ((await Promise.race([drain, timeout])) === 'timeout') {
      this.logger.warn({ pending: this.inFlight.size }, 'shutdown: mensagens ainda em andamento; devolvendo visibilidade');
      await Promise.allSettled(
        [...this.receipts.values()].map((receipt) =>
          this.client.send(
            new ChangeMessageVisibilityCommand({ QueueUrl: this.options.queueUrl, ReceiptHandle: receipt, VisibilityTimeout: 0 }),
          ),
        ),
      );
    }
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      const slots = this.options.concurrency - this.inFlight.size;
      if (slots <= 0) {
        await Promise.race(this.inFlight);
        continue;
      }
      let messages: Message[] = [];
      try {
        this.abort = new AbortController();
        const result = await this.client.send(
          new ReceiveMessageCommand({
            QueueUrl: this.options.queueUrl,
            MaxNumberOfMessages: Math.min(10, slots),
            WaitTimeSeconds: this.options.waitSeconds,
            MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
          }),
          { abortSignal: this.abort.signal },
        );
        messages = result.Messages ?? [];
      } catch (error) {
        if (this.stopping) break;
        this.logger.warn({ error: String(error) }, 'falha ao buscar mensagens no SQS; nova tentativa em 1s');
        await sleep(1000);
        continue;
      }
      // Mesma MessageGroupId (= wallet) em sequência, na ordem recebida; grupos diferentes em paralelo.
      for (const group of groupByMessageGroup(messages)) {
        for (const message of group) {
          if (message.MessageId && message.ReceiptHandle) this.receipts.set(message.MessageId, message.ReceiptHandle);
        }
        const task = (async () => {
          for (let i = 0; i < group.length; i++) {
            const message = group[i]!;
            if (this.stopping) {
              // shutdown: não começa nada novo; devolve o resto do grupo para outra instância
              await this.release(group.slice(i), 0);
              break;
            }
            const outcome = await this.process(message);
            if (message.MessageId) this.receipts.delete(message.MessageId);
            if (outcome.kind === 'retry') {
              // preserva a ordem da wallet: o resto do grupo espera junto com a mensagem que falhou
              await this.release(group.slice(i + 1), outcome.delaySeconds);
              break;
            }
          }
        })().finally(() => this.inFlight.delete(task));
        this.inFlight.add(task);
      }
    }
  }

  /** Devolve mensagens recebidas e não processadas (ficam visíveis após `delaySeconds`). */
  private async release(messages: Message[], delaySeconds: number): Promise<void> {
    await Promise.allSettled(
      messages.map((m) => {
        if (m.MessageId) this.receipts.delete(m.MessageId);
        return this.client.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: this.options.queueUrl,
            ReceiptHandle: m.ReceiptHandle!,
            VisibilityTimeout: delaySeconds,
          }),
        );
      }),
    );
  }

  private async process(message: Message): Promise<Disposition> {
    const body = message.Body ?? '';
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    const sqsMessageId = message.MessageId ?? 'unknown';
    const messageId = tryMessageId(body) ?? sqsMessageId;

    return logContext.run({ correlationId: messageId, messageId }, async () => {
      let disposition: Disposition;
      try {
        disposition = await this.handler.handle(body, receiveCount);
      } catch (error) {
        // O handler classifica tudo; se algo escapar, trate como transitório (nunca perca a mensagem).
        disposition = { kind: 'retry', delaySeconds: 5, reason: String(error) };
      }

      // Ponto exato do cenário "worker morto depois do commit e antes do ack".
      if (this.options.crashAfterCommit && disposition.kind === 'ack') {
        this.logger.warn({ messageId }, 'FAULT_CRASH_AFTER_COMMIT: encerrando antes do ack');
        process.exit(137);
      }

      try {
        await this.dispose(message, disposition);
      } catch (error) {
        // Sem ack/retry bem-sucedido a mensagem reaparece após o visibility timeout: seguro,
        // pois a inbox torna o reprocessamento um no-op.
        this.logger.warn({ messageId, error: String(error) }, 'falha ao confirmar/devolver a mensagem');
      }
      return disposition;
    });
  }

  private async dispose(message: Message, disposition: Disposition): Promise<void> {
    const receipt = message.ReceiptHandle!;
    switch (disposition.kind) {
      case 'ack':
        await this.client.send(new DeleteMessageCommand({ QueueUrl: this.options.queueUrl, ReceiptHandle: receipt }));
        return;
      case 'retry':
        await this.client.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: this.options.queueUrl,
            ReceiptHandle: receipt,
            VisibilityTimeout: disposition.delaySeconds,
          }),
        );
        return;
      case 'dead-letter':
        // Envia para a DLQ ANTES de apagar: se o envio falhar, a mensagem não se perde.
        await this.client.send(
          new SendMessageCommand({
            QueueUrl: this.options.dlqUrl,
            MessageBody: message.Body ?? '',
            MessageGroupId: message.Attributes?.MessageGroupId ?? 'dlq',
            MessageDeduplicationId: `dlq-${message.MessageId}`,
            MessageAttributes: {
              reason: { DataType: 'String', StringValue: disposition.reason },
              sourceMessageId: { DataType: 'String', StringValue: message.MessageId ?? 'unknown' },
            },
          }),
        );
        await this.client.send(new DeleteMessageCommand({ QueueUrl: this.options.queueUrl, ReceiptHandle: receipt }));
        return;
    }
  }
}

function groupByMessageGroup(messages: Message[]): Message[][] {
  const groups = new Map<string, Message[]>();
  for (const message of messages) {
    const key = message.Attributes?.MessageGroupId ?? message.MessageId ?? 'none';
    const list = groups.get(key);
    if (list) list.push(message);
    else groups.set(key, [message]);
  }
  return [...groups.values()];
}

function tryMessageId(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body);
    return typeof parsed?.messageId === 'string' ? parsed.messageId : undefined;
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
