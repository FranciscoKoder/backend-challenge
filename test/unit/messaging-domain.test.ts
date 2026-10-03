import { describe, expect, test } from 'bun:test';
import { canonicalJson, computePayloadHash, parseSubmitCommand } from '../../src/application/wager-command';
import { InboxMessage } from '../../src/messaging/domain/inbox-message';
import { OutboxMessage } from '../../src/messaging/domain/outbox-message';
import { InvalidTransactionStateError, ValidationError } from '../../src/shared/domain/errors';
import { Money } from '../../src/shared/domain/money';
import { WalletBalanceChanged } from '../../src/wagering/domain/events';
import { Wallet } from '../../src/wallet/domain/wallet';

const now = new Date('2026-07-29T15:00:00.000Z');
const WALLET_ID = '0192f291-27dd-7d3f-8071-5f8685deef37';

const body = (over: Record<string, unknown> = {}) => ({
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: WALLET_ID,
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
  ...over,
});

describe('idempotência: JSON canônico e payloadHash', () => {
  test('chaves são ordenadas recursivamente, sem espaços', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe('{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}');
  });

  test('undefined é omitido', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  test('ordem das chaves e escala do dinheiro não alteram o hash', () => {
    const a = parseSubmitCommand(body(), 'k');
    const reordered = Object.fromEntries(Object.entries(body()).reverse());
    const b = parseSubmitCommand({ ...reordered, money: { currency: 'BRL', amount: '25' } }, 'k');
    expect(computePayloadHash(a)).toBe(computePayloadHash(b));
  });

  test('o header Idempotency-Key NÃO entra no hash', () => {
    const a = parseSubmitCommand(body(), 'key-1');
    const b = parseSubmitCommand(body(), 'key-2');
    expect(computePayloadHash(a)).toBe(computePayloadHash(b));
  });

  test.each([
    ['valor', { money: { amount: '26.00', currency: 'BRL' } }],
    ['kind', { kind: 'WIN' }],
    ['rodada', { roundId: 'round-988' }],
    ['jogo', { gameId: 'other' }],
    ['wallet', { walletId: '0192f291-27dd-7d3f-8071-5f8685deef38' }],
    ['referência', { referenceExternalTransactionId: 'x' }],
  ])('payload com %s diferente gera hash diferente', (_name, override) => {
    const base = computePayloadHash(parseSubmitCommand(body(), 'k'));
    const changed = computePayloadHash(parseSubmitCommand(body(override), 'k'));
    expect(changed).not.toBe(base);
  });

  test('hash é SHA-256 hexadecimal', () => {
    expect(computePayloadHash(parseSubmitCommand(body(), 'k'))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('parseSubmitCommand', () => {
  test('usa providerId:externalTransactionId como chave padrão', () => {
    expect(parseSubmitCommand(body(), undefined).idempotencyKey).toBe('provider-a:transaction-123');
  });

  test('OPENING não pode ser submetido', () => {
    expect(() => parseSubmitCommand(body({ kind: 'OPENING' }), 'k')).toThrow(ValidationError);
  });

  test.each([
    ['campo ausente', { roundId: undefined }],
    ['walletId não UUID', { walletId: 'abc' }],
    ['kind desconhecido', { kind: 'TIP' }],
    ['amount como number', { money: { amount: 25, currency: 'BRL' } }],
    ['amount com notação científica', { money: { amount: '1e3', currency: 'BRL' } }],
    ['amount negativo', { money: { amount: '-1.00', currency: 'BRL' } }],
    ['amount com 3 casas', { money: { amount: '1.001', currency: 'BRL' } }],
  ])('rejeita payload inválido: %s', (_name, override) => {
    expect(() => parseSubmitCommand(body(override), 'k')).toThrow(ValidationError);
  });

  test('chave de idempotência inválida é rejeitada', () => {
    expect(() => parseSubmitCommand(body(), 'tem espaço')).toThrow(ValidationError);
    expect(() => parseSubmitCommand(body(), 'x'.repeat(256))).toThrow(ValidationError);
  });
});

describe('InboxMessage', () => {
  test('receive -> markProcessed uma única vez', () => {
    const m = InboxMessage.receive({ messageId: 'm1', consumerName: 'c', payloadHash: 'h', receivedAt: now });
    expect(m.isProcessed()).toBe(false);
    m.markProcessed(now);
    expect(m.isProcessed()).toBe(true);
    expect(m.processedAt).toEqual(now);
    expect(() => m.markProcessed(now)).toThrow(InvalidTransactionStateError);
  });
});

describe('OutboxMessage', () => {
  const { wallet, openingEntry } = Wallet.open({
    id: WALLET_ID,
    playerId: 'p',
    initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }),
    opening: { transactionId: 't', entryId: 'e' },
    now,
  });
  const event = WalletBalanceChanged.from(wallet, openingEntry!, { eventId: 'ev-1', correlationId: 'c-1', occurredAt: now });

  test('enqueue grava o envelope do evento com dinheiro como string', () => {
    const m = OutboxMessage.enqueue(event);
    expect(m.id).toBe('ev-1');
    expect(m.eventType).toBe('WalletBalanceChanged');
    expect(m.aggregateId).toBe(WALLET_ID);
    expect(m.payload).toMatchObject({
      eventId: 'ev-1',
      eventType: 'WalletBalanceChanged',
      version: 1,
      correlationId: 'c-1',
      occurredAt: '2026-07-29T15:00:00.000Z',
      data: { direction: 'CREDIT', money: { amount: '10.00', currency: 'BRL' }, walletVersion: 1 },
    });
    expect(() => JSON.stringify(m.payload)).not.toThrow();
  });

  test('pending/due/published', () => {
    const m = OutboxMessage.enqueue(event);
    expect(m.isPending()).toBe(true);
    expect(m.isDue(now)).toBe(true);
    m.markPublished(now);
    expect(m.isPending()).toBe(false);
    expect(m.isDue(now)).toBe(false);
    expect(() => m.markPublished(now)).toThrow(InvalidTransactionStateError);
  });

  test('scheduleRetry incrementa attempts e aplica backoff exponencial limitado', () => {
    const m = OutboxMessage.enqueue(event);
    m.scheduleRetry(now);
    expect(m.attempts).toBe(1);
    expect(m.nextAttemptAt?.getTime()).toBe(now.getTime() + 1_000);
    expect(m.isDue(now)).toBe(false);
    expect(m.isDue(new Date(now.getTime() + 1_000))).toBe(true);
    m.scheduleRetry(now);
    expect(m.nextAttemptAt?.getTime()).toBe(now.getTime() + 2_000);
    for (let i = 0; i < 20; i++) m.scheduleRetry(now);
    expect(m.nextAttemptAt?.getTime()).toBe(now.getTime() + 60_000); // teto
  });
});
