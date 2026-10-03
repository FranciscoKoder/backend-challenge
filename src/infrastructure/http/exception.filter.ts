import { ArgumentsHost, Catch, type ExceptionFilter, HttpException, Inject } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  IdempotencyConflictError,
  InboxPayloadConflictError,
  InvalidCursorError,
  TransactionNotFoundError,
  WalletConflictError,
  WalletNotFoundError,
} from '../../application/errors';
import { APP_LOGGER, type AppLogger } from '../../application/observability';
import { TransientInfrastructureError } from '../../application/ports';
import { ValidationError } from '../../shared/domain/errors';
import { correlationIdOf } from './correlation.middleware';

/**
 * Mapa único e consistente de erro -> HTTP (vale para TODOS os endpoints):
 *
 *   400  payload/parâmetro inválido            -> corrija e reenvie (nova tentativa idêntica falha igual)
 *   404  recurso inexistente
 *   409  conflito (idempotência, wallet duplicada) -> NÃO reenviar igual
 *   422  rejeição de negócio (corpo traz `failureCode`)  -> resultado definitivo (ver controller)
 *   202  aceito, processamento pendente (PENDING_REFERENCE) -> não reenviar, será resolvido
 *   503  falha transitória de infraestrutura + Retry-After -> reenvie com a MESMA Idempotency-Key
 *   500  erro inesperado
 */
@Catch()
export class ProblemExceptionFilter implements ExceptionFilter {
  constructor(@Inject(APP_LOGGER) private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request>();
    const correlationId = correlationIdOf(req);

    const { status, code, message, retryable } = this.translate(exception);
    if (status >= 500) {
      this.logger.error({ code, status, error: String(exception), correlationId }, 'erro ao atender requisição');
    }
    if (status === 503) res.setHeader('Retry-After', '1');
    res.status(status).json({ error: { code, message, retryable }, correlationId });
  }

  private translate(exception: unknown): { status: number; code: string; message: string; retryable: boolean } {
    if (exception instanceof IdempotencyConflictError) {
      return { status: 409, code: exception.code, message: exception.message, retryable: false };
    }
    if (exception instanceof WalletConflictError || exception instanceof InboxPayloadConflictError) {
      return { status: 409, code: exception.code, message: exception.message, retryable: false };
    }
    if (exception instanceof WalletNotFoundError || exception instanceof TransactionNotFoundError) {
      return { status: 404, code: exception.code, message: exception.message, retryable: false };
    }
    if (exception instanceof ValidationError || exception instanceof InvalidCursorError) {
      return { status: 400, code: exception.code, message: exception.message, retryable: false };
    }
    if (exception instanceof TransientInfrastructureError) {
      return {
        status: 503,
        code: 'TEMPORARILY_UNAVAILABLE',
        message: 'Falha transitória de infraestrutura; reenvie com a mesma Idempotency-Key',
        retryable: true,
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const message = typeof body === 'string' ? body : ((body as { message?: string }).message ?? exception.message);
      const code = status === 404 ? 'NOT_FOUND' : status === 400 ? 'BAD_REQUEST' : `HTTP_${status}`;
      return { status, code, message: Array.isArray(message) ? message.join('; ') : String(message), retryable: false };
    }
    return { status: 500, code: 'INTERNAL_ERROR', message: 'Erro interno', retryable: false };
  }
}
