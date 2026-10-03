import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { AppProcess } from '../support/app-process';
import { assertLedgerMatchesBalances, createTestDatabase, type TestDatabase, withClient } from '../support/database';
import { createTestQueues, type TestQueues, wagerMessage, waitFor } from '../support/sqs';

/**
 * Processos `bun` independentes (como pods/containers) compartilhando PostgreSQL e SQS.
 * Nenhum estado é compartilhado em memória: só o banco e a fila.
 */
describe('três ou mais processos reais da aplicação', () => {
  let db: TestDatabase;
  let queues: TestQueues;
  let apps: AppProcess[] = [];
  const at = (i: number) => apps[i % apps.length]!;
  const uid = () => randomBytes(5).toString('hex');

  const sql = <T = any>(text: string, params: unknown[] = []) =>
    withClient(db.url, async (c) => (await c.query(text, params)).rows as T[]);

  async function createWallet(initial: string) {
    const playerId = `player-${uid()}`;
    const res = await at(0).request('POST', '/wallets', { playerId, initialBalance: { amount: initial, currency: 'BRL' } });
    expect(res.status).toBe(201);
    return { walletId: res.body.id as string, playerId };
  }

  function wager(w: { walletId: string; playerId: string }, over: Record<string, unknown> = {}) {
    const externalTransactionId = (over.externalTransactionId as string) ?? `tx-${uid()}`;
    return {
      providerId: 'provider-a',
      externalTransactionId,
      playerId: w.playerId,
      walletId: w.walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
      ...over,
    };
  }

  const submit = (i: number, body: Record<string, unknown>) =>
    at(i).request('POST', '/wagering/transactions', body, {
      'Idempotency-Key': `${body.providerId}:${body.externalTransactionId}`,
    });

  beforeAll(async () => {
    db = await createTestDatabase();
    queues = await createTestQueues();
    apps = await Promise.all([1, 2, 3].map(() => AppProcess.start({ databaseUrl: db.url, queueEnv: queues.env })));
  });

  afterAll(async () => {
    await Promise.allSettled(apps.map((a) => a.kill()));
    await assertLedgerMatchesBalances(db.url);
    queues.close();
    await db.drop();
  });

  test('a mesma aposta 50x em paralelo, espalhada pelos 3 processos: 1 débito, 1×201 e 49×200', async () => {
    const w = await createWallet('1000.00');
    const body = wager(w, { money: { amount: '25.00', currency: 'BRL' } });
    const responses = await Promise.all(Array.from({ length: 50 }, (_, i) => submit(i, body)));
    const codes = responses.map((r) => r.status).sort();
    expect(codes.filter((c) => c === 201).length).toBe(1);
    expect(codes.filter((c) => c === 200).length).toBe(49);
    expect(new Set(responses.map((r) => r.body.transactionId)).size).toBe(1);
    expect(responses.every((r) => r.body.balance.amount === '975.00')).toBe(true);
    const [row] = await sql(`select count(*)::int n from wallet_ledger_entries where wallet_id = $1 and direction = 'DEBIT'`, [w.walletId]);
    expect(row.n).toBe(1);
  });

  test('cenário §8 com cada aposta em um processo: uma 201 PROCESSED, uma 422 INSUFFICIENT_FUNDS, saldo 20.00', async () => {
    const w = await createWallet('100.00');
    const [a, b] = await Promise.all([
      submit(0, wager(w, { money: { amount: '80.00', currency: 'BRL' } })),
      submit(1, wager(w, { money: { amount: '80.00', currency: 'BRL' } })),
    ]);
    expect([a!.status, b!.status].sort()).toEqual([201, 422]);
    expect([a, b].find((r) => r!.status === 422)!.body.failureCode).toBe('INSUFFICIENT_FUNDS');
    const wallet = await at(2).request('GET', `/wallets/${w.walletId}`);
    expect(wallet.body.balance.amount).toBe('20.00');
  });

  test('carga mista concorrente em vários processos termina consistente (reconciliação de todas as wallets)', async () => {
    const wallets = await Promise.all(Array.from({ length: 8 }, () => createWallet('200.00')));
    const requests: Array<Promise<unknown>> = [];
    for (let i = 0; i < 240; i++) {
      const w = wallets[i % wallets.length]!;
      const kind = i % 4 === 0 ? 'WIN' : i % 7 === 0 ? 'LOSS' : 'BET';
      const amount = ['1.00', '2.50', '7.25', '13.10'][i % 4]!;
      requests.push(submit(i, wager(w, { kind, money: { amount, currency: 'BRL' } })));
    }
    const results = (await Promise.all(requests)) as Array<{ status: number }>;
    expect(results.every((r) => [201, 422].includes(r.status))).toBe(true);
    for (const w of wallets) {
      const rec = await at(1).request('POST', `/wallets/${w.walletId}/reconciliation`);
      expect(rec.status).toBe(200);
      expect(rec.body.consistent).toBe(true);
    }
  });

  test('fila SQS consumida pelos 3 processos ao mesmo tempo, com mensagens duplicadas: efeito exatamente uma vez', async () => {
    const wallets = await Promise.all(Array.from({ length: 6 }, () => createWallet('100.00')));
    const messages = wallets.flatMap((w) =>
      Array.from({ length: 5 }, (_, j) =>
        wagerMessage({ ...wager(w, { externalTransactionId: `sqs-mp-${w.walletId}-${j}`, money: { amount: '3.00', currency: 'BRL' } }) }),
      ),
    );
    for (const m of messages) {
      const groupId = String(m.data.walletId);
      await queues.send(m, groupId);
      await queues.sendRaw(JSON.stringify(m), groupId); // reentrega do produtor (mesmo messageId)
    }
    await waitFor(
      async () => {
        const [row] = await sql(`select count(*)::int n from wager_transactions where external_transaction_id like 'sqs-mp-%' and status = 'PROCESSED'`);
        return row.n === messages.length;
      },
      { timeoutMs: 60_000, message: 'nem todas as mensagens foram processadas' },
    );
    for (const w of wallets) {
      const res = await at(2).request('GET', `/wallets/${w.walletId}`);
      expect(res.body.balance.amount).toBe('85.00'); // 100 - 5 * 3
    }
    const [dup] = await sql(`select count(*)::int n from inbox_messages where message_id in (${messages.map((_, i) => `$${i + 1}`).join(',')})`, messages.map((m) => m.messageId));
    expect(dup.n).toBe(messages.length);
  });

  test('três publishers na mesma outbox: nenhum evento perdido, nenhum duplicado', async () => {
    await waitFor(async () => {
      const [row] = await sql(`select count(*)::int n from outbox_messages where published_at is null`);
      return row.n === 0;
    }, { timeoutMs: 60_000, message: 'outbox não esvaziou' });
    const [total] = await sql(`select count(*)::int n from outbox_messages`);
    const events = await queues.drain(queues.urls.events, 100_000);
    const ids = events.map((e) => e.body.eventId);
    expect(new Set(ids).size).toBe(total.n);
    expect(ids.length).toBe(total.n);
  });

  test('REFUND chega em um processo antes da BET, que chega em outro: o worker de um terceiro resolve', async () => {
    const w = await createWallet('100.00');
    const betId = `bet-${uid()}`;
    const refund = await submit(0, wager(w, { kind: 'REFUND', referenceExternalTransactionId: betId, money: { amount: '30.00', currency: 'BRL' } }));
    expect(refund.status).toBe(202);
    expect(refund.body.status).toBe('PENDING_REFERENCE');
    const bet = await submit(1, wager(w, { externalTransactionId: betId, money: { amount: '30.00', currency: 'BRL' } }));
    expect(bet.status).toBe(201);
    await waitFor(async () => {
      const r = await at(2).request('GET', `/wagering/transactions/${refund.body.transactionId}`);
      return r.body.status === 'PROCESSED';
    }, { timeoutMs: 20_000 });
    expect((await at(0).request('GET', `/wallets/${w.walletId}`)).body.balance.amount).toBe('100.00');
  });

  test('processo morto (kill -9) no meio da carga e reiniciado: reenvios não duplicam e tudo fecha', async () => {
    const w = await createWallet('1000.00');
    const bodies = Array.from({ length: 60 }, () => wager(w, { money: { amount: '5.00', currency: 'BRL' } }));
    const inflight = bodies.map((b, i) => submit(i, b).catch(() => ({ status: 0, body: null })));
    await new Promise((r) => setTimeout(r, 30));
    const victim = apps[0]!;
    await victim.kill(); // sem shutdown hooks: conexões cortadas no meio de transações
    const results = await Promise.all(inflight);
    const lost = results.filter((r) => r.status !== 201 && r.status !== 200).length;

    // reinicia a instância e o "provedor" reenvia TUDO com as mesmas chaves (at-least-once)
    apps[0] = await AppProcess.start({ databaseUrl: db.url, queueEnv: queues.env });
    const retried = await Promise.all(bodies.map((b, i) => submit(i, b)));
    expect(retried.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    const [row] = await sql(`select count(*)::int n from wallet_ledger_entries where wallet_id = $1 and direction = 'DEBIT'`, [w.walletId]);
    expect(row.n).toBe(60);
    expect((await at(1).request('GET', `/wallets/${w.walletId}`)).body.balance.amount).toBe('700.00');
    console.log(`kill -9 durante a carga: ${lost} requisições sem resposta, todas reenviadas com sucesso`);
  });
});

describe('worker morto depois do COMMIT e antes do ack (processo real)', () => {
  test('a mensagem volta, a inbox reconhece e o débito não se repete', async () => {
    const db = await createTestDatabase();
    const queues = await createTestQueues({ SQS_VISIBILITY_TIMEOUT: '2' });
    const healthy: AppProcess[] = [];
    try {
      // API sem consumidor, só para criar a wallet
      const api = await AppProcess.start({
        databaseUrl: db.url,
        queueEnv: queues.env,
        roles: { sqsConsumer: false, outboxPublisher: false, pendingReferenceWorker: false },
      });
      healthy.push(api);
      const wallet = await api.request('POST', '/wallets', { playerId: 'crash-player', initialBalance: { amount: '100.00', currency: 'BRL' } });
      const walletId = wallet.body.id as string;

      const faulty = await AppProcess.start({
        databaseUrl: db.url,
        queueEnv: queues.env,
        roles: { sqsConsumer: true, outboxPublisher: false, pendingReferenceWorker: false },
        env: { FAULT_CRASH_AFTER_COMMIT: 'true' },
      });
      const message = wagerMessage(
        { providerId: 'provider-a', externalTransactionId: 'crash-tx', playerId: 'crash-player', walletId, money: { amount: '40.00', currency: 'BRL' } },
        'msg-crash',
      );
      await queues.send(message, walletId);

      expect(await faulty.exited).toBe(137); // morreu exatamente entre o COMMIT e o DeleteMessage
      const committed = await withClient(db.url, async (c) => (await c.query(`select status from wager_transactions where external_transaction_id = 'crash-tx'`)).rows);
      expect(committed).toEqual([{ status: 'PROCESSED' }]);
      const counts = await queues.count(queues.urls.transactions);
      expect(counts.visible + counts.inFlight).toBe(1); // sem ack: a mensagem continua na fila

      const consumer = await AppProcess.start({
        databaseUrl: db.url,
        queueEnv: queues.env,
        roles: { sqsConsumer: true, outboxPublisher: false, pendingReferenceWorker: false },
      });
      healthy.push(consumer);
      await waitFor(async () => {
        const c = await queues.count(queues.urls.transactions);
        return c.visible + c.inFlight === 0;
      }, { timeoutMs: 30_000, message: 'a mensagem não foi reprocessada/confirmada' });

      const balance = await api.request('GET', `/wallets/${walletId}`);
      expect(balance.body.balance.amount).toBe('60.00'); // um único débito
      const debits = await withClient(db.url, async (c) => (await c.query(`select count(*)::int n from wallet_ledger_entries where wallet_id = $1 and direction = 'DEBIT'`, [walletId])).rows[0].n);
      expect(debits).toBe(1);
      const dlq = await queues.count(queues.urls.transactionsDlq);
      expect(dlq.visible).toBe(0);
      await assertLedgerMatchesBalances(db.url);
    } finally {
      await Promise.allSettled(healthy.map((a) => a.kill()));
      queues.close();
      await db.drop();
    }
  });
});
