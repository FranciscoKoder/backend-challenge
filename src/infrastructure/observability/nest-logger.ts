import { Inject, Injectable, type LoggerService } from '@nestjs/common';
import { APP_LOGGER, type AppLogger } from '../../application/observability';

/** Encaminha os logs internos do Nest para o mesmo logger JSON da aplicação. */
@Injectable()
export class PinoNestLogger implements LoggerService {
  constructor(@Inject(APP_LOGGER) private readonly logger: AppLogger) {}

  log(message: unknown, ...optional: unknown[]) {
    this.logger.info({ context: contextOf(optional) }, String(message));
  }
  error(message: unknown, ...optional: unknown[]) {
    this.logger.error({ context: contextOf(optional) }, String(message));
  }
  warn(message: unknown, ...optional: unknown[]) {
    this.logger.warn({ context: contextOf(optional) }, String(message));
  }
  debug(message: unknown, ...optional: unknown[]) {
    this.logger.debug({ context: contextOf(optional) }, String(message));
  }
  verbose(message: unknown, ...optional: unknown[]) {
    this.logger.debug({ context: contextOf(optional) }, String(message));
  }
}

const contextOf = (optional: unknown[]): string | undefined => {
  const last = optional[optional.length - 1];
  return typeof last === 'string' ? last : undefined;
};
