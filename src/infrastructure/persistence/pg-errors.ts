import { TransientInfrastructureError } from '../../application/ports';

export interface PgErrorInfo {
  code?: string;
  constraint?: string;
  message: string;
}

/** Extrai `code`/`constraint` do erro do `pg`, mesmo embrulhado pelo MikroORM. */
export function pgErrorInfo(error: unknown): PgErrorInfo {
  const seen = new Set<unknown>();
  let current: any = error;
  let code: string | undefined;
  let constraint: string | undefined;
  let message = '';
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if (!message && typeof current.message === 'string') message = current.message;
    const c = current.code ?? current.sqlState;
    if (!code && typeof c === 'string') code = c;
    if (!constraint && typeof current.constraint === 'string') constraint = current.constraint;
    current = current.cause ?? current.previous ?? current.original;
  }
  return { code, constraint, message };
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const info = pgErrorInfo(error);
  return info.code === '23505' && (constraint === undefined || info.constraint === constraint);
}

/** Deadlock (40P01) e falha de serialização (40001): a transação pode ser refeita do zero. */
export function isRetryableConflict(error: unknown): boolean {
  const code = pgErrorInfo(error).code;
  return code === '40P01' || code === '40001';
}

const TRANSIENT_CLASSES = ['08', '53', '57', '58']; // conexão, recursos, intervenção do operador, I/O
const TRANSIENT_NODE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ConnectionTimeout',
]);

/** Indisponibilidade temporária do PostgreSQL (ou conflito retentável). */
export function isTransientDbError(error: unknown): boolean {
  if (error instanceof TransientInfrastructureError) return true;
  const { code, message } = pgErrorInfo(error);
  if (code && (isRetryableConflict(error) || TRANSIENT_CLASSES.includes(code.slice(0, 2)))) return true;
  if (code && TRANSIENT_NODE_CODES.has(code)) return true;
  return /timeout|terminating connection|connection (terminated|refused|reset)|Connection terminated/i.test(message);
}
