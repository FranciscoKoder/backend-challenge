import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { DeleteMessageCommand } from '@aws-sdk/client-sqs';
import { type AppLogger, noopLogger as silent } from '../../src/application/observability';

const noopLogger: AppLogger = process.env.TEST_DEBUG
  ? { debug: () => {}, info: () => {}, warn: (f, m) => console.warn(m, f), error: (f, m) => console.error(m, f) }
  : silent;
import { TransientInfrastructureError, type UnitOfWork } from '../../src/application/ports';
import { SqsTransactionConsumer } from '../../src/infrastructure/messaging/sqs-consumer';
import { WagerMessageHandler } from '../../src/infrastructure/messaging/wager-message-handler';
import { PromMetrics } from '../../src/infrastructure/observability/metrics';
import { assertLedgerMatchesBalances, createTestDatabase, type TestDatabase, withClient } from '../support/database';
import { createWallet, startTestApp, type TestApp } from '../support/fixtures';
import { createTestQueues, type TestQueues, wagerMessage, waitFor } from '../support/sqs';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('consumidor SQS: inbox, ack após commit, retry e DLQ (PostgreSQL + SQS reais)', () => {
  let db: TestDatabase;
  let queues: TestQueues;
  let app: TestApp;
  const metrics = new PromMetrics({ defaultMetrics: false });
  const running: SqsTransactionConsumer[] = [];

  const makeConsumer = (
    target: TestApp = app,
    options: { client?: TestQueues['client']; wagering?: TestApp['core']['wagering'] } = {},
  ) => {
    const handler = new WagerMessageHandler(options.wagering ?? target.core.wagering, {
      maxReceiveCount: queues.config.sqs.maxReceiveCount,
      retryBaseSeconds: 0,
      metrics,
      logger: noopLogger,
    });
    const consumer = new SqsTransactionConsumer(
      options.client ?? queues.client,
      handler,
      {
        queueUrl: queues.urls.transactions,
        dlqUrl: queues.urls.transactionsDlq,
        concurrency: 5,
        waitSeconds: 1,
        crashAfterCommit: false,
        drainTimeoutMs: 10_000,
      },
      noopLogger,
    );
    running.push(consumer);
    return consumer;
  };

  const dbCount = (sql: string, params: unknown[] = []) =>
    withClient(db.url, async (c) => Number((await c.query(sql, params)).rows[0].n));

  const queueEmpty = async () => {
    const c = await queues.count(queues.urls.transactions);
    return c.visible + c.inFlight + c.delayed === 0;
  };

  const msg = (walletId: string, playerId: string, id: string, extra: Record<string, unknown> = {}, messageId?: string) =>
    wagerMessage(
      { providerId: 'provider-a', externalTransactionId: id, playerId, walletId, money: { amount: '25.00', currency: 'BRL' }, ...extra },
      messageId,
    );

  beforeAll(async () => {
    db = await createTestDatabase();
    app = await startTestApp(db.url);
  });

  // Filas novas e nenhum consumidor sobrando entre testes: um teste não rouba mensagens do outro.
  beforeEach(async () => {
    queues = await createTestQueues();
  });

  afterEach(async () => {
    await Promise.allSettled(running.splice(0).map((c) => c.stop()));
    queues.close();
  });

  afterAll(async () => {
    await app.close();
    await db.drop();
  });

  test('processa a mensagem com o mesmo use case, grava a inbox e só então confirma (ack)', async () => {
    const { walletId, playerId } = await createWallet(app, '100.00');
    const consumer = makeConsumer();
    consumer.start();

    await queues.send(msg(walletId, playerId, 'sqs-1', {}, 'msg-sqs-1'), walletId);
    await waitFor(async () => (await app.core.wallets.get(walletId)).balance.amount === '75.00', { message: 'não debitou' });
    await waitFor(queueEmpty, { message: 'mensagem não foi confirmada' });

    expect(await dbCount(`select count(*) n from inbox_messages where message_id = 'msg-sqs-1' and processed_at is not null`)).toBe(1);
    expect(await dbCount(`select count(*) n from wager_transactions where external_transaction_id = 'sqs-1'`)).toBe(1);
    await consumer.stop();
  });

  test('redelivery da MESMA mensagem (messageId igual) não duplica o débito', async () => {
    const { walletId, playerId } = await createWallet(app, '100.00');
    const consumer = makeConsumer();
    consumer.start();

    const message = msg(walletId, playerId, 'sqs-redelivery', {}, 'msg-redelivery');
    // O SQS FIFO dedupa por MessageDeduplicationId; aqui usamos ids diferentes para simular
    // reentrega pelo produtor/at-least-once: o corpo é idêntico.
    for (let i = 0; i < 5; i++) await queues.sendRaw(JSON.stringify(message), walletId);
    await waitFor(queueEmpty);
    await sleep(300);

    expect((await app.core.wallets.get(walletId)).balance.amount).toBe('75.00');
    expect(await dbCount(`select count(*) n from wallet_ledger_entries where wallet_id = $1 and direction = 'DEBIT'`, [walletId])).toBe(1);
    expect(await dbCount(`select count(*) n from inbox_messages where message_id = 'msg-redelivery'`)).toBe(1);
    await consumer.stop();
    await assertLedgerMatchesBalances(db.url);
  });

  test('mensagens diferentes com a mesma transação do provedor viram replay, não novo débito', async () => {
    const { walletId, playerId } = await createWallet(app, '100.00');
    const consumer = makeConsumer();
    consumer.start();
    await queues.send(msg(walletId, playerId, 'sqs-same-tx', {}, 'msg-a'), walletId);
    await queues.send(msg(walletId, playerId, 'sqs-same-tx', {}, 'msg-b'), walletId);
    await waitFor(queueEmpty);
    await sleep(300);
    expect((await app.core.wallets.get(walletId)).balance.amount).toBe('75.00');
    expect(await dbCount(`select count(*) n from inbox_messages where message_id in ('msg-a','msg-b')`)).toBe(2);
    await consumer.stop();
  });

  test('rejeição de negócio é terminal: transação REJECTED persistida, ack e nada na DLQ', async () => {
    const { walletId, playerId } = await createWallet(app, '10.00');
    const dlqBefore = (await queues.count(queues.urls.transactionsDlq)).visible;
    const consumer = makeConsumer();
    consumer.start();
    await queues.send(msg(walletId, playerId, 'sqs-reject', { money: { amount: '50.00', currency: 'BRL' } }, 'msg-reject'), walletId);
    await waitFor(async () => (await dbCount(`select count(*) n from wager_transactions where external_transaction_id = 'sqs-reject' and status = 'REJECTED' and failure_code = 'INSUFFICIENT_FUNDS'`)) === 1);
    await waitFor(queueEmpty);
    expect((await queues.count(queues.urls.transactionsDlq)).visible).toBe(dlqBefore);
    expect((await app.core.wallets.get(walletId)).balance.amount).toBe('10.00');
    await consumer.stop();
  });

  test('erros permanentes vão para a DLQ com o motivo: mensagem malformada, wallet inexistente, conflito', async () => {
    const { walletId, playerId } = await createWallet(app, '100.00');
    await queues.sendRaw('isto não é json', 'g-malformed');
    await queues.send({ messageId: 'x', type: 'OtherType', occurredAt: new Date().toISOString(), data: {} }, 'g-type');
    await queues.send(msg('0192f291-27dd-7d3f-8071-5f8685deef37', 'ghost', 'sqs-ghost', {}, 'msg-ghost'), 'g-ghost');
    await queues.send(msg(walletId, playerId, 'sqs-bad-money', { money: { amount: '1e3', currency: 'BRL' } }, 'msg-bad-money'), walletId);
    // conflito de idempotência: mesma chave, valor diferente
    await queues.send(msg(walletId, playerId, 'sqs-conflict', {}, 'msg-c1'), walletId);
    await queues.send(msg(walletId, playerId, 'sqs-conflict', { money: { amount: '26.00', currency: 'BRL' } }, 'msg-c2'), walletId);

    const consumer = makeConsumer();
    consumer.start();
    const reasons: string[] = [];
    await waitFor(async () => {
      const dlq = await queues.drain(queues.urls.transactionsDlq, 50);
      reasons.push(...dlq.map((m) => m.attributes.reason!));
      return reasons.length >= 5;
    }, { timeoutMs: 30_000 }).catch((e) => {
      throw new Error(`DLQ recebeu só ${JSON.stringify(reasons)}: ${e}`);
    });
    await waitFor(queueEmpty);

    expect(reasons.sort()).toEqual(['IDEMPOTENCY_CONFLICT', 'INVALID_MONEY', 'MALFORMED_MESSAGE', 'MALFORMED_MESSAGE', 'WALLET_NOT_FOUND']);
    expect((await app.core.wallets.get(walletId)).balance.amount).toBe('75.00'); // só a primeira de sqs-conflict
    await consumer.stop();
  });

  test('falha transitória: retry com backoff e depois processa; sem efeitos duplicados', async () => {
    const { walletId, playerId } = await createWallet(app, '100.00');
    let failures = 2;
    const flaky = await startTestApp(db.url, {
      wrapUow: (uow): UnitOfWork => ({
        run: (work) => {
          if (failures-- > 0) return Promise.reject(new TransientInfrastructureError('postgres fora do ar (injetado)'));
          return uow.run(work);
        },
        read: (work) => uow.read(work),
      }),
    });
    const consumer = makeConsumer(flaky);
    consumer.start();
    await queues.send(msg(walletId, playerId, 'sqs-transient', {}, 'msg-transient'), walletId);
    await waitFor(async () => (await app.core.wallets.get(walletId)).balance.amount === '75.00', { timeoutMs: 30_000 });
    await waitFor(queueEmpty);
    expect(failures).toBeLessThan(0);
    expect(await dbCount(`select count(*) n from wallet_ledger_entries where wallet_id = $1 and direction = 'DEBIT'`, [walletId])).toBe(1);
    await consumer.stop();
    await flaky.close();
  });

  test('falha transitória que nunca passa esgota as tentativas e vai para a DLQ (RETRIES_EXHAUSTED)', async () => {
    const { walletId, playerId } = await createWallet(app, '100.00');
    const down = await startTestApp(db.url, {
      wrapUow: (uow): UnitOfWork => ({
        run: () => Promise.reject(new TransientInfrastructureError('postgres fora do ar (injetado)')),
        read: (work) => uow.read(work),
      }),
    });
    const consumer = makeConsumer(down);
    consumer.start();
    await queues.send(msg(walletId, playerId, 'sqs-exhaust', {}, 'msg-exhaust'), walletId);
    const found = await waitFor(async () => {
      const dlq = await queues.drain(queues.urls.transactionsDlq, 20);
      return dlq.find((m) => m.body?.messageId === 'msg-exhaust');
    }, { timeoutMs: 40_000 });
    expect(found.attributes.reason).toBe('RETRIES_EXHAUSTED');
    expect((await app.core.wallets.get(walletId)).balance.amount).toBe('100.00');
    await consumer.stop();
    await down.close();
  });

  test('worker morre depois do commit e antes do ack: a mensagem volta e a inbox evita novo débito', async () => {
    const { walletId, playerId } = await createWallet(app, '100.00');
    let dropAcks = true;
    const lossyClient = new Proxy(queues.client, {
      get(target, prop, receiver) {
        if (prop === 'send') {
          return (command: unknown, ...rest: unknown[]) =>
            command instanceof DeleteMessageCommand && dropAcks
              ? Promise.reject(new Error('conexão perdida antes do ack'))
              : (target.send as (...a: unknown[]) => unknown)(command, ...rest);
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const consumer = makeConsumer(app, { client: lossyClient });
    consumer.start();
    await queues.send(msg(walletId, playerId, 'sqs-no-ack', {}, 'msg-no-ack'), walletId);
    // o commit acontece, o ack falha
    await waitFor(async () => (await app.core.wallets.get(walletId)).balance.amount === '75.00');
    expect(await queueEmpty()).toBe(false);
    dropAcks = false; // a mensagem reaparece depois do visibility timeout
    await waitFor(queueEmpty, { timeoutMs: 30_000, message: 'mensagem nunca foi reentregue/confirmada' });
    expect((await app.core.wallets.get(walletId)).balance.amount).toBe('75.00');
    expect(await dbCount(`select count(*) n from wallet_ledger_entries where wallet_id = $1 and direction = 'DEBIT'`, [walletId])).toBe(1);
    await consumer.stop();
  });

  test('shutdown gracioso: conclui a mensagem em andamento antes de encerrar', async () => {
    const { walletId, playerId } = await createWallet(app, '100.00');
    let started = false;
    const slow = {
      submit: async (...args: Parameters<TestApp['core']['wagering']['submit']>) => {
        started = true;
        await sleep(1500);
        return app.core.wagering.submit(...args);
      },
    } as unknown as TestApp['core']['wagering'];
    const consumer = makeConsumer(app, { wagering: slow });
    consumer.start();
    await queues.send(msg(walletId, playerId, 'sqs-shutdown', {}, 'msg-shutdown'), walletId);
    await waitFor(async () => started);
    await consumer.stop(); // chamado com a mensagem ainda em andamento
    expect((await app.core.wallets.get(walletId)).balance.amount).toBe('75.00');
    await waitFor(queueEmpty);
  });

  test('reinício: parar no meio de um lote e subir outra instância processa tudo exatamente uma vez', async () => {
    const { walletId, playerId } = await createWallet(app, '1000.00');
    const N = 30;
    for (let i = 0; i < N; i++) {
      await queues.send(msg(walletId, playerId, `sqs-restart-${i}`, { money: { amount: '10.00', currency: 'BRL' } }, `msg-restart-${i}`), walletId);
    }
    const first = await startTestApp(db.url);
    const a = makeConsumer(first);
    a.start();
    await waitFor(async () => (await dbCount(`select count(*) n from wager_transactions where external_transaction_id like 'sqs-restart-%'`)) >= 3);
    await a.stop();
    await first.close(); // "instância A morreu"

    const second = await startTestApp(db.url);
    const b = makeConsumer(second);
    b.start();
    await waitFor(async () => (await dbCount(`select count(*) n from wager_transactions where external_transaction_id like 'sqs-restart-%' and status = 'PROCESSED'`)) === N, { timeoutMs: 60_000 });
    await waitFor(queueEmpty, { timeoutMs: 30_000 });
    await b.stop();
    await second.close();

    expect((await app.core.wallets.get(walletId)).balance.amount).toBe('700.00'); // 1000 - 30 * 10
    expect(await dbCount(`select count(*) n from wallet_ledger_entries where wallet_id = $1 and direction = 'DEBIT'`, [walletId])).toBe(N);
    await assertLedgerMatchesBalances(db.url);
  });

  test('métricas: DLQ e duplicatas são contabilizadas', async () => {
    const text = await metrics.registry.metrics();
    expect(text).toContain('sqs_dlq_messages_total{reason="MALFORMED_MESSAGE"}');
    expect(text).toContain('wager_duplicates_detected_total');
  });
});
