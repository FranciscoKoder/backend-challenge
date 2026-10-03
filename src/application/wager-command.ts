import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Money } from '../shared/domain/money';
import { ValidationError } from '../shared/domain/errors';
import { WagerTransactionKind } from '../wagering/domain/wager-transaction';

const id = (max: number) => z.string().trim().min(1).max(max);

const moneySchema = z.object({
  amount: z.string(),
  currency: z.string(),
});

/** Kinds que um provedor pode enviar. `OPENING` é interno e fica de fora. */
const SUBMITTABLE_KINDS = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
] as const;

/** Campos de negócio (o que compõe o payloadHash). Sem header nem metadados de transporte. */
export const wagerBodySchema = z
  .object({
    providerId: id(64),
    externalTransactionId: id(128),
    playerId: id(128),
    walletId: z.string().uuid(),
    roundId: id(128),
    gameId: id(128),
    kind: z.enum(SUBMITTABLE_KINDS),
    money: moneySchema,
    referenceExternalTransactionId: id(128).optional(),
  });

export type WagerBody = z.infer<typeof wagerBodySchema>;

export interface SubmitWagerCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[\x21-\x7e]+$/, 'caracteres ASCII imprimíveis, sem espaços');

export function defaultIdempotencyKey(body: { providerId: string; externalTransactionId: string }): string {
  return `${body.providerId}:${body.externalTransactionId}`;
}

/** Valida o corpo + a chave e normaliza o dinheiro. Erros viram `ValidationError`. */
export function parseSubmitCommand(rawBody: unknown, rawKey: unknown): SubmitWagerCommand {
  const body = wagerBodySchema.safeParse(rawBody);
  if (!body.success) {
    throw new ValidationError('INVALID_PAYLOAD', formatZodIssues(body.error));
  }
  const key = idempotencyKeySchema.safeParse(rawKey ?? defaultIdempotencyKey(body.data));
  if (!key.success) {
    throw new ValidationError('INVALID_IDEMPOTENCY_KEY', formatZodIssues(key.error));
  }
  const money = Money.from(body.data.money); // InvalidMoneyError (ValidationError)
  return {
    providerId: body.data.providerId,
    externalTransactionId: body.data.externalTransactionId,
    idempotencyKey: key.data,
    playerId: body.data.playerId,
    walletId: body.data.walletId.toLowerCase(),
    roundId: body.data.roundId,
    gameId: body.data.gameId,
    kind: body.data.kind as WagerTransactionKind,
    money,
    referenceExternalTransactionId: body.data.referenceExternalTransactionId,
  };
}

export function formatZodIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '(raiz)'}: ${issue.message}`).join('; ');
}

/**
 * JSON canônico: objetos com chaves ordenadas (recursivamente), sem espaços, `undefined`
 * omitido. Duas representações equivalentes do mesmo payload geram exatamente a mesma string.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * payloadHash = SHA-256 (hex) do JSON canônico dos campos de negócio, com o dinheiro já
 * normalizado (escala 2). O header Idempotency-Key e metadados de transporte ficam de fora.
 */
export function computePayloadHash(command: Omit<SubmitWagerCommand, 'idempotencyKey'>): string {
  const business = {
    providerId: command.providerId,
    externalTransactionId: command.externalTransactionId,
    playerId: command.playerId,
    walletId: command.walletId,
    roundId: command.roundId,
    gameId: command.gameId,
    kind: command.kind,
    money: command.money.toJSON(),
    referenceExternalTransactionId: command.referenceExternalTransactionId,
  };
  return createHash('sha256').update(canonicalJson(business)).digest('hex');
}
