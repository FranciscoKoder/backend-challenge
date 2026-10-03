import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { EventPublisher, UnitOfWork } from '../../src/application/ports';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { createTestDatabase, type TestDatabase, withClient } from '../support/database';
import { command, createWallet, httpCtx, memoryPublisher, money, startTestApp, type TestApp } from '../support/fixtures';
import { createTestQueues, type TestQueues } from '../support/sqs';

const pending = (url: string) =>
  withClient(url, async (c) => Number((await c.query(`select count(*) n from outbox_messages where published_at is null`)).rows[0].n));

/** Gera `n` eventos (cada BET grava 2: Processed + BalanceChanged). */
async function produceEvents(app: TestApp, bets: number): Promise<void> {
  const { walletId, playerId } = await createWallet(app, '100000.00');
  for (let i = 0; i < bets; i++) {
    await app.core.wagering.submit(command({ walletId, playerId, money: money('1.00') }), httpCtx());
  }
}

async function drainOutbox(app: TestApp, batchSize = 10): Promise<void> {
  for (;;) {
    const { published, failed } = await app.core.outbox.publishBatch(batchSize);
    if (published + failed === 0) return;
  }
}

describe('transactional outbox (PostgreSQL + SQS reais)', () => {
  let db: TestDatabase;
  let queues: TestQueues;

  beforeAll(async () => {
    db = await createTestDatabase();
    queues = await createTestQueues();
  });

  afterAll(async () => {
    queues.close();
    await db.drop();
  });

  test('publica na fila de eventos SQS só depois do commit, com envelope versionado', async () => {
    const publisher = new SqsEventPublisher(queues.client, async () => queues.urls.events);
    const app = await startTestApp(db.url, { publisher });
    try {
      const { walletId, playerId } = await createWallet(app, '100.00');
      const outcome = await app.core.wagering.submit(command({ walletId, playerId, money: money('10.00') }), httpCtx('corr-outbox'));

      // nada foi publicado ainda: o evento está só na outbox (commitado)
      expect((await queues.count(queues.urls.events)).visible).toBe(0);
      await drainOutbox(app);
      expect(await pending(db.url)).toBe(0);

      const events = await queues.drain(queues.urls.events);
      const mine = events.filter((e) => e.body.data.walletId === walletId);
      expect(mine.map((e) => e.body.eventType).sort()).toEqual([
        'WagerTransactionProcessed', // OPENING
        'WagerTransactionProcessed', // BET
        'WalletBalanceChanged',
        'WalletBalanceChanged',
      ]);
      const changed = mine.find((e) => e.body.eventType === 'WalletBalanceChanged' && e.body.data.transactionId === outcome.transactionId)!;
      expect(changed.body).toMatchObject({
        version: 1,
        aggregateId: walletId,
        correlationId: 'corr-outbox',
        data: { balanceAfter: { amount: '90.00', currency: 'BRL' }, direction: 'DEBIT' },
      });
      expect(typeof changed.body.occurredAt).toBe('string');
      expect(changed.attributes.eventType).toBe('WalletBalanceChanged');
    } finally {
      await app.close();
    }
  });

  test('vários publishers concorrentes: cada evento é publicado exatamente uma vez', async () => {
    const producer = await startTestApp(db.url);
    await produceEvents(producer, 60); // 2 (abertura) + 120 eventos
    await producer.close();
    const total = await pending(db.url);
    expect(total).toBeGreaterThanOrEqual(120);

    const sink = memoryPublisher();
    const slowSink: EventPublisher = {
      async publish(message) {
        await new Promise((r) => setTimeout(r, 2)); // força sobreposição entre publishers
        await sink.publish(message);
      },
    };
    const publishers = await Promise.all([1, 2, 3, 4].map(() => startTestApp(db.url, { publisher: slowSink })));
    try {
      await Promise.all(publishers.map((p) => drainOutbox(p, 7)));
    } finally {
      await Promise.all(publishers.map((p) => p.close()));
    }

    const ids = sink.published.map((e) => e.eventId);
    expect(ids.length).toBe(total);
    expect(new Set(ids).size).toBe(total); // nenhum duplicado
    expect(await pending(db.url)).toBe(0);
  });

  test('falha ao publicar: agenda retry com backoff, mantém a ordem da wallet e não bloqueia outras wallets', async () => {
    const producer = await startTestApp(db.url);
    const a = await createWallet(producer, '10.00');
    const b = await createWallet(producer, '10.00');
    await producer.close();

    const sink = memoryPublisher();
    const failingForA: EventPublisher = {
      async publish(message) {
        if ((message.payload as any).data.walletId === a.walletId) throw new Error('SQS indisponível');
        await sink.publish(message);
      },
    };
    const app = await startTestApp(db.url, { publisher: failingForA });
    try {
      await drainOutbox(app);
    } finally {
      await app.close();
    }
    expect(sink.published.some((e) => e.data.walletId === b.walletId)).toBe(true);
    const rowsA = await withClient(db.url, async (c) =>
      (await c.query(`select attempts, next_attempt_at, last_error, published_at from outbox_messages where payload->'data'->>'walletId' = $1 order by seq`, [a.walletId])).rows,
    );
    expect(rowsA[0].attempts).toBe(1);
    expect(rowsA[0].next_attempt_at).not.toBeNull();
    expect(rowsA[0].last_error).toContain('SQS indisponível');
    // o segundo evento da mesma wallet não passa na frente do primeiro, nem em lotes seguintes
    expect(rowsA[1].attempts).toBe(0);
    expect(rowsA.every((r) => r.published_at === null)).toBe(true);
  });

  test('processo morre depois do commit e antes de publicar: outra instância publica', async () => {
    // instância A grava (commit) e "morre" sem publicar: simplesmente nunca roda o publisher
    const instanceA = await startTestApp(db.url);
    const { walletId, playerId } = await createWallet(instanceA, '50.00');
    await instanceA.core.wagering.submit(command({ walletId, playerId, money: money('5.00') }), httpCtx());
    await instanceA.close();

    const sink = memoryPublisher();
    const instanceB = await startTestApp(db.url, { publisher: sink });
    try {
      await new Promise((r) => setTimeout(r, 1100)); // passa do backoff do teste anterior
      await drainOutbox(instanceB);
    } finally {
      await instanceB.close();
    }
    expect(sink.published.filter((e) => e.data.walletId === walletId).length).toBe(4);
  });

  test('publicou mas caiu antes de marcar: o evento é publicado de novo (at-least-once) com o mesmo eventId', async () => {
    const producer = await startTestApp(db.url);
    const { walletId } = await createWallet(producer, '1.00');
    await producer.close();

    const sink = memoryPublisher();
    let crash = true;
    const crashing = await startTestApp(db.url, {
      publisher: sink,
      wrapUow: (uow): UnitOfWork => ({
        run: (work) =>
          uow.run(async (repos) =>
            work({
              ...repos,
              outbox: {
                ...repos.outbox,
                lockDue: (now, limit) => repos.outbox.lockDue(now, limit),
                recordFailure: (m, e) => repos.outbox.recordFailure(m, e),
                stats: (now) => repos.outbox.stats(now),
                enqueue: (m) => repos.outbox.enqueue(m),
                markPublished: async (m) => {
                  if (crash) throw new Error('processo morreu antes do COMMIT');
                  return repos.outbox.markPublished(m);
                },
              },
            }),
          ),
        read: (work) => uow.read(work),
      }),
    });
    try {
      await new Promise((r) => setTimeout(r, 1100));
      await expect(crashing.core.outbox.publishBatch(50)).rejects.toThrow('processo morreu');
      crash = false;
      await drainOutbox(crashing);
    } finally {
      await crashing.close();
    }
    const forWallet = sink.published.filter((e) => e.data.walletId === walletId);
    const ids = forWallet.map((e) => e.eventId);
    expect(ids.length).toBeGreaterThan(new Set(ids).size); // houve publicação duplicada...
    expect(new Set(ids).size).toBe(2); // ...mas são os mesmos 2 eventos: o consumidor deduplica por eventId
  });

  test('duplicata publicada no SQS FIFO com o mesmo eventId é descartada pela deduplicação da fila', async () => {
    const publisher = new SqsEventPublisher(queues.client, async () => queues.urls.events);
    const app = await startTestApp(db.url, { publisher });
    try {
      const { walletId } = await createWallet(app, '3.00');
      const [row] = await app.core.uow.run((repos) => repos.outbox.lockDue(new Date(Date.now() + 3600_000), 500));
      expect(row).toBeDefined();
      const rows = await app.core.uow.run((repos) => repos.outbox.lockDue(new Date(Date.now() + 3600_000), 500));
      const event = rows.find((r) => (r.message.payload as any).data.walletId === walletId)!.message;
      await queues.drain(queues.urls.events); // limpa
      await publisher.publish(event);
      await publisher.publish(event); // reentrega do publisher
      const received = (await queues.drain(queues.urls.events)).filter((e) => e.body.eventId === event.id);
      expect(received.length).toBe(1);
    } finally {
      await app.close();
    }
  });
});
