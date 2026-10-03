import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { AppProcess } from '../support/app-process';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { createTestQueues, type TestQueues } from '../support/sqs';

describe('API HTTP (processo real): contratos e mapeamento de status', () => {
  let db: TestDatabase;
  let queues: TestQueues;
  let app: AppProcess;
  let walletId: string;
  const playerId = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

  const body = (over: Record<string, unknown> = {}) => ({
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    playerId,
    walletId,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...over,
  });
  const key = (b: { providerId: string; externalTransactionId: string }) => ({
    'Idempotency-Key': `${b.providerId}:${b.externalTransactionId}`,
  });

  beforeAll(async () => {
    db = await createTestDatabase();
    queues = await createTestQueues();
    app = await AppProcess.start({ databaseUrl: db.url, queueEnv: queues.env });
  });

  afterAll(async () => {
    await app.kill();
    queues.close();
    await db.drop();
  });

  test('POST /wallets cria com OPENING e version 1; duplicada é 409', async () => {
    const res = await app.request('POST', '/wallets', { playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ playerId, balance: { amount: '1000.00', currency: 'BRL' }, version: 1 });
    walletId = res.body.id;

    const dup = await app.request('POST', '/wallets', { playerId, initialBalance: { amount: '5.00', currency: 'BRL' } });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatchObject({ code: 'WALLET_ALREADY_EXISTS', retryable: false });
  });

  test('POST /wallets com payload inválido é 400', async () => {
    const res = await app.request('POST', '/wallets', { playerId, initialBalance: { amount: 10, currency: 'BRL' } });
    expect(res.status).toBe(400);
    const bad = await app.request('POST', '/wallets', { playerId: '', initialBalance: { amount: '1.00', currency: 'BRL' } });
    expect(bad.status).toBe(400);
  });

  test('POST /wagering/transactions: 201 novo, 200 replay idêntico, 409 payload divergente', async () => {
    const b = body();
    const first = await app.request('POST', '/wagering/transactions', b, key(b));
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '975.00', currency: 'BRL' }, idempotentReplay: false });

    const replay = await app.request('POST', '/wagering/transactions', b, key(b));
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });

    const conflict = await app.request('POST', '/wagering/transactions', body({ money: { amount: '26.00', currency: 'BRL' } }), key(b));
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', retryable: false });
  });

  test('rejeição de negócio é 422 com failureCode e orientação ao provedor', async () => {
    const b = body({ externalTransactionId: 'too-much', money: { amount: '5000.00', currency: 'BRL' } });
    const res = await app.request('POST', '/wagering/transactions', b, key(b));
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', advice: 'GIVE_UP', idempotentReplay: false });
  });

  test('referência ausente é 202 (aceito, pendente)', async () => {
    const b = body({ externalTransactionId: 'rf-1', kind: 'REFUND', referenceExternalTransactionId: 'not-yet' });
    const res = await app.request('POST', '/wagering/transactions', b, key(b));
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('PENDING_REFERENCE');
  });

  test('validações de contrato são 400', async () => {
    const noKey = await app.request('POST', '/wagering/transactions', body({ externalTransactionId: 'nk' }));
    expect(noKey.status).toBe(400);
    expect(noKey.body.error.code).toBe('MISSING_IDEMPOTENCY_KEY');

    for (const amount of ['1e3', '-1.00', '1.001', 'NaN', 'Infinity', '']) {
      const b = body({ externalTransactionId: `inv-${amount}`, money: { amount, currency: 'BRL' } });
      const res = await app.request('POST', '/wagering/transactions', b, key(b));
      expect(res.status).toBe(400);
    }
    const opening = body({ externalTransactionId: 'op', kind: 'OPENING' });
    expect((await app.request('POST', '/wagering/transactions', opening, key(opening))).status).toBe(400);

    const refundWithoutRef = body({ externalTransactionId: 'rf-noref', kind: 'REFUND' });
    expect((await app.request('POST', '/wagering/transactions', refundWithoutRef, key(refundWithoutRef))).status).toBe(400);

    const malformed = await fetch(`${app.url}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'x' },
      body: '{"broken": ',
    });
    expect(malformed.status).toBe(400);
  });

  test('wallet inexistente é 404', async () => {
    const b = body({ externalTransactionId: 'ghost', walletId: '0192f291-27dd-7d3f-8071-5f8685deef00' });
    expect((await app.request('POST', '/wagering/transactions', b, key(b))).status).toBe(404);
    expect((await app.request('GET', '/wallets/0192f291-27dd-7d3f-8071-5f8685deef00')).status).toBe(404);
    expect((await app.request('GET', '/wallets/not-a-uuid')).status).toBe(404);
  });

  test('consultas de transação por id interno e por id do provedor', async () => {
    const byProvider = await app.request('GET', '/providers/provider-a/wagering/transactions/transaction-123');
    expect(byProvider.status).toBe(200);
    expect(byProvider.body).toMatchObject({ kind: 'BET', status: 'PROCESSED', money: { amount: '25.00', currency: 'BRL' } });
    const byId = await app.request('GET', `/wagering/transactions/${byProvider.body.transactionId}`);
    expect(byId.body).toEqual(byProvider.body);
    expect((await app.request('GET', '/providers/provider-a/wagering/transactions/nope')).status).toBe(404);
  });

  test('ledger paginado com cursor opaco e estável', async () => {
    for (let i = 0; i < 4; i++) {
      const b = body({ externalTransactionId: `page-${i}`, money: { amount: '1.00', currency: 'BRL' } });
      await app.request('POST', '/wagering/transactions', b, key(b));
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const qs: string = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : '?limit=2';
      const page = await app.request('GET', `/wallets/${walletId}/ledger${qs}`);
      expect(page.status).toBe(200);
      expect(page.body.entries.length).toBeLessThanOrEqual(2);
      seen.push(...page.body.entries.map((e: { id: string }) => e.id));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(seen.length).toBe(6); // OPENING + BET + 4
    expect(new Set(seen).size).toBe(6);
    expect((await app.request('GET', `/wallets/${walletId}/ledger?cursor=lixo`)).status).toBe(400);
    expect((await app.request('GET', `/wallets/${walletId}/ledger?limit=0`)).status).toBe(400);
  });

  test('reconciliação consistente', async () => {
    const res = await app.request('POST', `/wallets/${walletId}/reconciliation`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      walletId,
      storedBalance: { amount: '971.00', currency: 'BRL' },
      calculatedBalance: { amount: '971.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 6,
    });
  });

  test('health: live e ready sem autenticação; métricas expostas', async () => {
    expect((await app.request('GET', '/health/live')).body).toEqual({ status: 'ok' });
    const ready = await app.request('GET', '/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.checks).toEqual({ postgres: 'up', sqs: 'up' });

    const metrics = await fetch(`${app.url}/metrics`).then((r) => r.text());
    for (const name of [
      'wager_transactions_total',
      'wager_duplicates_detected_total',
      'wager_idempotency_conflicts_total',
      'wallet_lock_wait_seconds',
      'wager_processing_duration_seconds',
      'outbox_lag_seconds',
      'outbox_pending_messages',
    ]) {
      expect(metrics).toContain(name);
    }
  });

  test('correlationId é propagado no header de resposta', async () => {
    const res = await fetch(`${app.url}/health/live`, { headers: { 'X-Correlation-Id': 'abc-123' } });
    expect(res.headers.get('x-correlation-id')).toBe('abc-123');
  });

  test('logs são JSON estruturado, com correlationId e sem valores monetários', async () => {
    const b = body({ externalTransactionId: 'log-check', money: { amount: '1.23', currency: 'BRL' } });
    await fetch(`${app.url}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Correlation-Id': 'corr-log-check', ...key(b) },
      body: JSON.stringify(b),
    });
    await new Promise((r) => setTimeout(r, 300));
    const lines = app.logs.filter((l) => l.includes('corr-log-check'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.correlationId).toBe('corr-log-check');
      expect(line).not.toContain('1.23');
    }
  });
});
