import { randomBytes } from 'node:crypto';
import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { type AppConfig, loadConfig } from '../../src/config/config';
import { type QueueUrls, createSqsClient, ensureQueues } from '../../src/infrastructure/messaging/sqs-client';

export const AWS_ENDPOINT = process.env.TEST_AWS_ENDPOINT_URL ?? 'http://localhost:4566';

export interface TestQueues {
  config: AppConfig;
  client: SQSClient;
  urls: QueueUrls;
  /** Variáveis de ambiente para subir processos da aplicação apontando para estas filas. */
  env: Record<string, string>;
  send(message: object, groupId?: string): Promise<void>;
  sendRaw(body: string, groupId: string, dedupId?: string): Promise<void>;
  count(queueUrl: string): Promise<{ visible: number; inFlight: number; delayed: number }>;
  /** Consome (lê e apaga) as mensagens da fila. */
  drain(queueUrl: string, max?: number): Promise<Array<{ body: any; attributes: Record<string, string> }>>;
  close(): void;
}

/** Cria filas FIFO isoladas (prefixo aleatório) no SQS de teste (LocalStack/MiniStack). */
export async function createTestQueues(overrides: Record<string, string> = {}): Promise<TestQueues> {
  const prefix = `t${randomBytes(4).toString('hex')}-`;
  const env: Record<string, string> = {
    AWS_ENDPOINT_URL: AWS_ENDPOINT,
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    SQS_QUEUE_PREFIX: prefix,
    SQS_MAX_RECEIVE_COUNT: '3',
    SQS_WAIT_SECONDS: '1',
    SQS_VISIBILITY_TIMEOUT: '3',
    ...overrides,
  };
  const config = loadConfig(env);
  const client = createSqsClient(config);
  const urls = await ensureQueues(client, config);

  const sendRaw = async (body: string, groupId: string, dedupId = randomBytes(8).toString('hex')) => {
    await client.send(
      new SendMessageCommand({
        QueueUrl: urls.transactions,
        MessageBody: body,
        MessageGroupId: groupId,
        MessageDeduplicationId: dedupId,
      }),
    );
  };

  return {
    config,
    client,
    urls,
    env,
    sendRaw,
    send: (message, groupId = 'default') => sendRaw(JSON.stringify(message), groupId),
    async count(queueUrl) {
      const r = await client.send(
        new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['All'] }),
      );
      return {
        visible: Number(r.Attributes?.ApproximateNumberOfMessages ?? 0),
        inFlight: Number(r.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
        delayed: Number(r.Attributes?.ApproximateNumberOfMessagesDelayed ?? 0),
      };
    },
    async drain(queueUrl, max = 1000) {
      const out: Array<{ body: any; attributes: Record<string, string> }> = [];
      for (let empty = 0; empty < 2 && out.length < max; ) {
        const r = await client.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 1,
            VisibilityTimeout: 600,
            MessageAttributeNames: ['All'],
          }),
        );
        const messages = r.Messages ?? [];
        if (messages.length === 0) {
          empty += 1;
          continue;
        }
        empty = 0;
        for (const m of messages) {
          // apaga ao ler: em FIFO, mensagem em voo trava o grupo inteiro
          await client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle! }));
          out.push({
            body: safeParse(m.Body ?? ''),
            attributes: Object.fromEntries(
              Object.entries(m.MessageAttributes ?? {}).map(([k, v]) => [k, v.StringValue ?? '']),
            ),
          });
        }
      }
      return out;
    },
    close: () => client.destroy(),
  };
}

export async function purge(client: SQSClient, queueUrl: string): Promise<void> {
  await client.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));
}

/** Mensagem `WagerTransactionRequested` no formato do enunciado. */
export function wagerMessage(
  data: Record<string, unknown>,
  messageId = `msg-${randomBytes(6).toString('hex')}`,
): { messageId: string; type: string; occurredAt: string; data: Record<string, unknown> } {
  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      idempotencyKey: `${data.providerId}:${data.externalTransactionId}`,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      ...data,
    },
  };
}

export async function waitFor<T>(
  probe: () => Promise<T | undefined | false>,
  options: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(options.message ?? 'waitFor: tempo esgotado');
    await new Promise((r) => setTimeout(r, options.intervalMs ?? 100));
  }
}

function safeParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
