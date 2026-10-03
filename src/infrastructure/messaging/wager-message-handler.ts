import { z } from 'zod';
import type { AppLogger, Metrics } from '../../application/observability';
import { TransientInfrastructureError } from '../../application/ports';
import { canonicalJson, formatZodIssues, parseSubmitCommand } from '../../application/wager-command';
import { type WagerProcessingService, hashMessageBody } from '../../application/wager-processing.service';
import { DomainError } from '../../shared/domain/errors';

export const CONSUMER_NAME = 'wager-transactions-consumer';

const envelopeSchema = z.object({
  messageId: z.string().trim().min(1).max(255),
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.string().datetime({ offset: true }),
  correlationId: z.string().trim().min(1).max(128).optional(),
  data: z.record(z.unknown()),
});

/** O que fazer com a mensagem SQS depois de tentar processá-la. */
export type Disposition =
  | { kind: 'ack' }
  /** Erro transitório: devolve a mensagem à fila com atraso (backoff). */
  | { kind: 'retry'; delaySeconds: number; reason: string }
  /** Erro permanente (ou tentativas esgotadas): vai para a DLQ. */
  | { kind: 'dead-letter'; reason: string };

export interface HandlerOptions {
  maxReceiveCount: number;
  /** Base do backoff exponencial entre tentativas (segundos): delay = base * 2^tentativa. */
  retryBaseSeconds: number;
  metrics: Metrics;
  logger: AppLogger;
}

/**
 * Traduz uma mensagem SQS em uma chamada ao MESMO use case da API HTTP e classifica o
 * resultado:
 *   - sucesso, rejeição de negócio, duplicata  -> ack (rejeição é resultado, não falha);
 *   - falha transitória                         -> retry com backoff exponencial;
 *   - falha permanente / limite de tentativas   -> DLQ.
 */
export class WagerMessageHandler {
  constructor(
    private readonly wagering: WagerProcessingService,
    private readonly options: HandlerOptions,
  ) {}

  async handle(body: string, receiveCount: number): Promise<Disposition> {
    let messageId: string | undefined;
    try {
      const envelope = envelopeSchema.safeParse(safeJson(body));
      if (!envelope.success) {
        return this.deadLetter('MALFORMED_MESSAGE', { detail: formatZodIssues(envelope.error) });
      }
      messageId = envelope.data.messageId;
      const { idempotencyKey, ...business } = envelope.data.data as Record<string, unknown>;
      const command = parseSubmitCommand(business, idempotencyKey);

      const outcome = await this.wagering.submit(command, {
        source: 'sqs',
        correlationId: envelope.data.correlationId ?? messageId,
        causationId: messageId,
        inbox: {
          consumerName: CONSUMER_NAME,
          messageId,
          messageHash: hashMessageBody(canonicalJson({ type: envelope.data.type, data: envelope.data.data })),
        },
      });
      this.options.logger.info(
        {
          messageId,
          transactionId: outcome.transactionId,
          providerId: command.providerId,
          walletId: command.walletId,
          status: outcome.status,
          duplicate: outcome.duplicateMessage === true || outcome.idempotentReplay,
        },
        'mensagem processada',
      );
      return { kind: 'ack' };
    } catch (error) {
      return this.classify(error, receiveCount, messageId);
    }
  }

  private classify(error: unknown, receiveCount: number, messageId: string | undefined): Disposition {
    if (isPermanent(error)) {
      return this.deadLetter(permanentReason(error), { messageId, error: errorMessage(error) });
    }
    // Transitório ou desconhecido: retenta até o limite e então vai para a DLQ.
    if (receiveCount >= this.options.maxReceiveCount) {
      return this.deadLetter('RETRIES_EXHAUSTED', { messageId, receiveCount, error: errorMessage(error) });
    }
    const delaySeconds = Math.min(300, 2 ** receiveCount * this.options.retryBaseSeconds);
    this.options.metrics.retry('sqs_transient');
    this.options.logger.warn(
      { messageId, receiveCount, delaySeconds, error: errorMessage(error) },
      'falha transitória; mensagem volta à fila com backoff',
    );
    return { kind: 'retry', delaySeconds, reason: errorMessage(error) };
  }

  private deadLetter(reason: string, fields: Record<string, unknown> = {}): Disposition {
    this.options.metrics.dlqMessage(reason);
    this.options.logger.error({ reason, ...fields }, 'mensagem enviada à DLQ');
    return { kind: 'dead-letter', reason };
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isPermanent(error: unknown): boolean {
  if (error instanceof TransientInfrastructureError) return false;
  // Todo erro de domínio (validação, conflito de idempotência, wallet inexistente, invariantes)
  // é determinístico: reenviar a mesma mensagem produziria o mesmo erro.
  return error instanceof DomainError;
}

function permanentReason(error: unknown): string {
  return error instanceof DomainError ? error.code : 'PERMANENT_ERROR';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
