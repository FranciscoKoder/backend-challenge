import { describe, expect, test } from 'bun:test';
import { InvalidTransactionStateError, ValidationError } from '../../src/shared/domain/errors';
import { Money } from '../../src/shared/domain/money';
import { FailureCode } from '../../src/wagering/domain/failure-code';
import {
  type CreateWagerTransactionProps,
  type PendingReferencePolicy,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/wagering/domain/wager-transaction';
import { LedgerDirection } from '../../src/wallet/domain/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const now = new Date('2026-07-29T15:00:00.000Z');
const policy: PendingReferencePolicy = { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 3000 };

function props(overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  return {
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'a'.repeat(64),
    walletId: 'w1',
    playerId: 'p1',
    roundId: 'round-1',
    gameId: 'game',
    kind: Kind.Bet,
    money: brl('25.00'),
    createdAt: now,
    ...overrides,
  };
}

const tx = (overrides: Partial<CreateWagerTransactionProps> = {}) => WagerTransaction.create(props(overrides));

describe('WagerTransaction: criação', () => {
  test('nasce em PENDING', () => {
    const t = tx();
    expect(t.status).toBe(Status.Pending);
    expect(t.isTerminal()).toBe(false);
  });

  test('OPENING é interno e não pode ser criado pela factory pública', () => {
    expect(() => tx({ kind: Kind.Opening })).toThrow(ValidationError);
  });

  test('createOpening já nasce PROCESSED com o saldo resultante', () => {
    const { kind: _kind, referenceExternalTransactionId: _ref, ...opening } = props({ providerId: 'internal' });
    const t = WagerTransaction.createOpening(opening, brl('1000.00'));
    expect(t.kind).toBe(Kind.Opening);
    expect(t.status).toBe(Status.Processed);
    expect(t.resultBalance?.amount).toBe('1000.00');
  });

  test('REFUND e ROLLBACK exigem referência; os demais não', () => {
    expect(() => tx({ kind: Kind.Refund })).toThrow(ValidationError);
    expect(() => tx({ kind: Kind.Rollback })).toThrow(ValidationError);
    expect(tx({ kind: Kind.Refund, referenceExternalTransactionId: 'ext-0' }).requiresReference()).toBe(true);
    expect(tx({ kind: Kind.Win }).requiresReference()).toBe(false);
  });

  test('BET não aceita referência', () => {
    expect(() => tx({ kind: Kind.Bet, referenceExternalTransactionId: 'x' })).toThrow(ValidationError);
  });

  test('valor deve ser positivo', () => {
    expect(() => tx({ money: brl('0.00') })).toThrow(ValidationError);
  });

  test('affectsBalance é falso apenas para LOSS', () => {
    expect(tx({ kind: Kind.Loss }).affectsBalance()).toBe(false);
    for (const kind of [Kind.Bet, Kind.Win]) expect(tx({ kind }).affectsBalance()).toBe(true);
  });

  test('matchesPayload compara o hash', () => {
    expect(tx().matchesPayload('a'.repeat(64))).toBe(true);
    expect(tx().matchesPayload('b'.repeat(64))).toBe(false);
  });
});

describe('WagerTransaction: transições', () => {
  test('PENDING -> PROCESSED guarda referência, instante e saldo observado', () => {
    const t = tx();
    t.markProcessed('ref-id', now, brl('975.00'));
    expect(t.status).toBe(Status.Processed);
    expect(t.referenceTransactionId).toBe('ref-id');
    expect(t.processedAt).toEqual(now);
    expect(t.resultBalance?.amount).toBe('975.00');
    expect(t.isTerminal()).toBe(true);
  });

  test('PENDING -> REJECTED guarda o código de falha', () => {
    const t = tx();
    t.reject(FailureCode.InsufficientFunds, brl('10.00'));
    expect(t.status).toBe(Status.Rejected);
    expect(t.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(t.isTerminal()).toBe(true);
  });

  test('PENDING -> FAILED é terminal e auditável', () => {
    const t = tx();
    t.fail(FailureCode.InternalPermanentError);
    expect(t.status).toBe(Status.Failed);
    expect(t.failureCode).toBe(FailureCode.InternalPermanentError);
  });

  test.each([
    ['markProcessed', (t: WagerTransaction) => t.markProcessed(undefined, now)],
    ['reject', (t: WagerTransaction) => t.reject(FailureCode.InsufficientFunds)],
    ['fail', (t: WagerTransaction) => t.fail(FailureCode.InternalPermanentError)],
    ['markPendingReference', (t: WagerTransaction) => t.markPendingReference(now, policy)],
  ])('estado terminal não aceita %s', (_name, act) => {
    for (const terminate of [
      (t: WagerTransaction) => t.markProcessed(undefined, now),
      (t: WagerTransaction) => t.reject(FailureCode.InsufficientFunds),
      (t: WagerTransaction) => t.fail(FailureCode.InternalPermanentError),
    ]) {
      const t = tx();
      terminate(t);
      const before = t.status;
      expect(() => act(t)).toThrow(InvalidTransactionStateError);
      expect(t.status).toBe(before);
    }
  });

  test('PENDING_REFERENCE só pode seguir para PROCESSED, REJECTED ou FAILED', () => {
    const t = tx({ kind: Kind.Refund, referenceExternalTransactionId: 'b' });
    t.markPendingReference(now, policy);
    expect(t.status).toBe(Status.PendingReference);
    expect(() => t.markPendingReference(now, policy)).toThrow(InvalidTransactionStateError);
    t.markProcessed('ref', now);
    expect(t.status).toBe(Status.Processed);
  });
});

describe('WagerTransaction: espera por referência (backoff)', () => {
  test('agenda a primeira tentativa em baseDelay e dobra a cada retry, até o teto', () => {
    const t = tx({ kind: Kind.Refund, referenceExternalTransactionId: 'b' });
    t.markPendingReference(now, policy);
    expect(t.nextAttemptAt?.getTime()).toBe(now.getTime() + 1000);

    expect(t.registerReferenceRetry(now, policy)).toBe('RETRY_SCHEDULED');
    expect(t.pendingAttempts).toBe(1);
    expect(t.nextAttemptAt?.getTime()).toBe(now.getTime() + 2000);

    // 3a tentativa atinge o limite
    expect(t.registerReferenceRetry(now, policy)).toBe('RETRY_SCHEDULED');
    expect(t.nextAttemptAt?.getTime()).toBe(now.getTime() + 3000); // teto 3000 (4000 limitado)
    expect(t.registerReferenceRetry(now, policy)).toBe('EXHAUSTED');
  });

  test('só PENDING_REFERENCE registra tentativas', () => {
    expect(() => tx().registerReferenceRetry(now, policy)).toThrow(InvalidTransactionStateError);
  });
});

describe('WagerTransaction: direção do ledger', () => {
  test('BET debita; WIN, REFUND e OPENING creditam', () => {
    expect(tx({ kind: Kind.Bet }).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(tx({ kind: Kind.Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(tx({ kind: Kind.Refund, referenceExternalTransactionId: 'b' }).ledgerDirectionFor()).toBe(
      LedgerDirection.Credit,
    );
  });

  test('ROLLBACK é o inverso da referência', () => {
    const rb = tx({ kind: Kind.Rollback, referenceExternalTransactionId: 'x' });
    expect(rb.ledgerDirectionFor(tx({ kind: Kind.Bet }))).toBe(LedgerDirection.Credit);
    expect(rb.ledgerDirectionFor(tx({ kind: Kind.Win }))).toBe(LedgerDirection.Debit);
    expect(
      rb.ledgerDirectionFor(tx({ kind: Kind.Refund, referenceExternalTransactionId: 'b' })),
    ).toBe(LedgerDirection.Debit);
    expect(() => rb.ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
  });

  test('LOSS não gera lançamento', () => {
    expect(() => tx({ kind: Kind.Loss }).ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
  });
});

describe('WagerTransaction: validação da referência', () => {
  const bet = tx({ id: 'bet', kind: Kind.Bet, externalTransactionId: 'bet-ext' });
  const refund = (o: Partial<CreateWagerTransactionProps> = {}) =>
    tx({ id: 'rf', kind: Kind.Refund, referenceExternalTransactionId: 'bet-ext', ...o });

  test('referência coerente é aceita', () => {
    expect(refund().checkReference(bet)).toBeUndefined();
  });

  test.each([
    ['providerId', { providerId: 'provider-b' }],
    ['playerId', { playerId: 'p2' }],
    ['walletId', { walletId: 'w2' }],
    ['roundId', { roundId: 'round-2' }],
  ])('%s diferente -> REFERENCE_MISMATCH', (_field, override) => {
    expect(refund(override).checkReference(bet)).toBe(FailureCode.ReferenceMismatch);
  });

  test('moeda diferente -> REFERENCE_MISMATCH', () => {
    const usdRefund = refund({ money: Money.from({ amount: '25.00', currency: 'USD' }) });
    expect(usdRefund.checkReference(bet)).toBe(FailureCode.ReferenceMismatch);
  });

  test('valor diferente em reversão -> AMOUNT_MISMATCH', () => {
    expect(refund({ money: brl('24.99') }).checkReference(bet)).toBe(FailureCode.AmountMismatch);
  });

  test('REFUND só referencia BET', () => {
    const win = tx({ id: 'w', kind: Kind.Win });
    expect(refund().checkReference(win)).toBe(FailureCode.ReferenceKindInvalid);
  });

  test('ROLLBACK referencia BET, WIN ou REFUND, mas não LOSS', () => {
    const rollback = tx({ id: 'rb', kind: Kind.Rollback, referenceExternalTransactionId: 'x' });
    const refunded = tx({ id: 'r', kind: Kind.Refund, referenceExternalTransactionId: 'b' });
    expect(rollback.checkReference(bet)).toBeUndefined();
    expect(rollback.checkReference(tx({ kind: Kind.Win }))).toBeUndefined();
    expect(rollback.checkReference(refunded)).toBeUndefined();
    expect(rollback.checkReference(tx({ kind: Kind.Loss }))).toBe(FailureCode.ReferenceKindInvalid);
  });

  test('WIN pode referenciar a BET da rodada sem exigir valor igual', () => {
    const win = tx({ kind: Kind.Win, money: brl('99.00'), referenceExternalTransactionId: 'bet-ext' });
    expect(win.checkReference(bet)).toBeUndefined();
  });
});
