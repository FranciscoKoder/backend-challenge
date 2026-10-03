import { SendMessageBatchCommand, SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher } from '../../application/ports';
import type { OutboxMessage } from '../../messaging/domain/outbox-message';

/**
 * Publica eventos da outbox em uma fila FIFO. `MessageDeduplicationId = eventId` e
 * `MessageGroupId = walletId` (ordem por wallet). A deduplicação do SQS é só otimização:
 * consumidores devem deduplicar por `eventId`.
 */
export class SqsEventPublisher implements EventPublisher {
  private urlPromise?: Promise<string>;

  constructor(
    private readonly client: SQSClient,
    private readonly resolveUrl: () => Promise<string>,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.client.send(new SendMessageCommand({ QueueUrl: await this.queueUrl(), ...entry(message) }));
  }

  /** Até 10 por chamada (limite do SQS). Entradas da mesma wallet seguem na ordem do lote. */
  async publishBatch(messages: OutboxMessage[]): Promise<Map<string, string>> {
    const failed = new Map<string, string>();
    const queueUrl = await this.queueUrl();
    for (let i = 0; i < messages.length; i += 10) {
      const chunk = messages.slice(i, i + 10);
      try {
        const result = await this.client.send(
          new SendMessageBatchCommand({
            QueueUrl: queueUrl,
            Entries: chunk.map((m, index) => ({ Id: String(index), ...entry(m) })),
          }),
        );
        for (const f of result.Failed ?? []) {
          failed.set(chunk[Number(f.Id)]!.id, `${f.Code}: ${f.Message ?? ''}`);
        }
      } catch (error) {
        for (const m of chunk) failed.set(m.id, error instanceof Error ? error.message : String(error));
      }
    }
    return failed;
  }

  private queueUrl(): Promise<string> {
    this.urlPromise ??= this.resolveUrl().catch((error) => {
      this.urlPromise = undefined; // permite nova tentativa quando a fila aparecer
      throw error;
    });
    return this.urlPromise;
  }
}

function entry(message: OutboxMessage) {
  return {
    MessageBody: JSON.stringify(message.payload),
    MessageGroupId: message.orderingKey,
    MessageDeduplicationId: message.id,
    MessageAttributes: {
      eventType: { DataType: 'String', StringValue: message.eventType },
    },
  };
}
