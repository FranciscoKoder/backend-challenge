import { AsyncLocalStorage } from 'node:async_hooks';
import pino, { type Logger } from 'pino';
import type { AppLogger } from '../../application/observability';

export interface LogContext {
  correlationId: string;
  messageId?: string;
}

/** Contexto assíncrono: o correlationId acompanha a requisição/mensagem sem ser repassado à mão. */
export const logContext = new AsyncLocalStorage<LogContext>();

export function createPino(level: string): Logger {
  return pino({
    level,
    base: undefined, // sem pid/hostname: ruído em container
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    mixin() {
      const ctx = logContext.getStore();
      return ctx ? { correlationId: ctx.correlationId, ...(ctx.messageId ? { messageId: ctx.messageId } : {}) } : {};
    },
    // Defesa em profundidade: nunca deixe campos sensíveis/financeiros vazarem para o log.
    redact: {
      paths: ['*.money', '*.balance', '*.initialBalance', 'money', 'balance', 'authorization', '*.authorization'],
      censor: '[redacted]',
    },
  });
}

export class PinoAppLogger implements AppLogger {
  constructor(private readonly logger: Logger) {}

  debug(fields: Record<string, unknown>, message: string): void {
    this.logger.debug(fields, message);
  }
  info(fields: Record<string, unknown>, message: string): void {
    this.logger.info(fields, message);
  }
  warn(fields: Record<string, unknown>, message: string): void {
    this.logger.warn(fields, message);
  }
  error(fields: Record<string, unknown>, message: string): void {
    this.logger.error(fields, message);
  }
}
