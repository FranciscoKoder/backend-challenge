import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AppLogger } from '../../application/observability';
import { logContext } from '../observability/logger';

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Garante um `correlationId` por requisição (usa `X-Correlation-Id` se for seguro), devolve-o
 * no header de resposta, o propaga via AsyncLocalStorage e registra uma linha de log por request.
 */
export function correlationMiddleware(logger: AppLogger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.header('x-correlation-id');
    const correlationId = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader('x-correlation-id', correlationId);
    (req as Request & { correlationId: string }).correlationId = correlationId;

    const startedAt = performance.now();
    res.on('finish', () => {
      logContext.run({ correlationId }, () => {
        if (req.path.startsWith('/health') || req.path === '/metrics') return;
        logger.info(
          {
            method: req.method,
            route: req.route?.path ?? req.path,
            status: res.statusCode,
            durationMs: Math.round(performance.now() - startedAt),
          },
          'request concluída',
        );
      });
    });
    logContext.run({ correlationId }, next);
  };
}

export const correlationIdOf = (req: Request): string =>
  (req as Request & { correlationId?: string }).correlationId ?? randomUUID();
