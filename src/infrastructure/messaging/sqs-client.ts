import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  QueueDoesNotExist,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { AppConfig } from '../../config/config';

export function createSqsClient(config: AppConfig): SQSClient {
  return new SQSClient({
    region: config.aws.region,
    ...(config.aws.endpoint ? { endpoint: config.aws.endpoint } : {}),
    // LocalStack aceita credenciais fictícias; em AWS real vêm da cadeia padrão.
    ...(config.aws.endpoint
      ? {
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
          },
        }
      : {}),
    maxAttempts: 3,
  });
}

export interface QueueUrls {
  transactions: string;
  transactionsDlq: string;
  events: string;
}

/**
 * Cria (idempotentemente) a DLQ, a fila de transações com redrive e a fila de eventos.
 * O redrive do SQS é só uma rede de segurança: o consumidor aplica o limite por conta
 * própria e move para a DLQ antes disso (maxReceiveCount + 1 no redrive).
 */
export async function ensureQueues(client: SQSClient, config: AppConfig): Promise<QueueUrls> {
  const names = config.sqs.queues;
  const dlq = await client.send(
    new CreateQueueCommand({
      QueueName: names.transactionsDlq,
      Attributes: { FifoQueue: 'true', MessageRetentionPeriod: '1209600' },
    }),
  );
  const dlqUrl = dlq.QueueUrl!;
  const attrs = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }),
  );
  const dlqArn = attrs.Attributes!.QueueArn!;

  const main = await client.send(
    new CreateQueueCommand({
      QueueName: names.transactions,
      Attributes: {
        FifoQueue: 'true',
        VisibilityTimeout: String(config.sqs.visibilityTimeout),
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqArn,
          maxReceiveCount: config.sqs.maxReceiveCount + 1,
        }),
      },
    }),
  );
  const events = await client.send(
    new CreateQueueCommand({ QueueName: names.events, Attributes: { FifoQueue: 'true' } }),
  );
  return { transactions: main.QueueUrl!, transactionsDlq: dlqUrl, events: events.QueueUrl! };
}

/** Resolve as URLs das filas já existentes (sem criar). */
export async function resolveQueueUrls(client: SQSClient, config: AppConfig): Promise<QueueUrls> {
  const get = async (name: string) => (await client.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl!;
  const names = config.sqs.queues;
  return {
    transactions: await get(names.transactions),
    transactionsDlq: await get(names.transactionsDlq),
    events: await get(names.events),
  };
}

export { QueueDoesNotExist };
