import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { FailureCode } from '../../src/wagering/domain/failure-code';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/wagering/domain/wager-transaction';
import { assertLedgerMatchesBalances, createTestDatabase, type TestDatabase, withClient } from '../support/database';
import { FakeClock, POLICY, command, createWallet, httpCtx, money, startTestApp, type TestApp, withOverrides } from '../support/fixtures';
import { InvariantViolationError } from '../../src/shared/domain/errors';
import type { UnitOfWork } from '../../src/application/ports';

async function events(url: string, transactionId: string): Promise<string[]> {
  return withClient(url, async (c) =>
    (await c.query(`select event_type from outbox_messages where payload->'data'->>'transactionId' = $1 order by seq`, [transactionId])).rows.map((r) => r.event_type),
  );
}

describe('referências fora de ordem: PENDING_REFERENCE + worker com backoff', () => {
  let db: TestDatabase;
  let app: TestApp;
  const clock = new FakeClock(new Date('2026-07-29T15:00:00.000Z'));

  beforeAll(async () => {
    db = await createTestDatabase();
    app = await startTestApp(db.url, { clock });
  });

  afterAll(async () => {
    await assertLedgerMatchesBalances(db.url);
    await app.close();
    await db.drop();
  });

  /** Processa tudo que estiver vencido, como o worker faria. */
  async function runWorker(): Promise<number> {
    let n = 0;
    while (await app.core.wagering.reprocessNextPending()) n += 1;
    return n;
  }

  /** Ids de provedor são únicos por provider: cada teste usa o seu sufixo. */
  const tagger = () => {
    const tag = Math.random().toString(36).slice(2, 8);
    return (name: string) => `${name}-${tag}`;
  };

  test('REFUND chega antes da BET: fica PENDING_REFERENCE e é resolvido quando a BET chega', async () => {
    const id = tagger();
    const { walletId, playerId } = await createWallet(app, '100.00');
    const refund = await app.core.wagering.submit(
      command({ walletId, playerId, externalTransactionId: id('rf'), kind: Kind.Refund, referenceExternalTransactionId: id('bet'), money: money('30.00') }),
      httpCtx(),
    );
    expect(refund.status).toBe(Status.PendingReference);
    expect(refund.balance).toBeUndefined();
    expect(await events(db.url, refund.transactionId)).toEqual(['WagerTransactionPendingReference']);
    expect((await app.core.wallets.get(walletId)).balance.amount).toBe('100.00');

    // ainda sem a BET: nada vencido
    expect(await runWorker()).toBe(0);

    await app.core.wagering.submit(command({ walletId, playerId, externalTransactionId: id('bet'), money: money('30.00') }), httpCtx());
    expect((await app.core.wallets.get(walletId)).balance.amount).toBe('70.00');

    // a BET "acordou" o dependente: reprocessa já, sem esperar o backoff
    expect(await runWorker()).toBe(1);
    const stored = await app.core.wallets.getTransaction(refund.transactionId);
    expect(stored.status).toBe(Status.Processed);
    expect(stored.resultBalance?.amount).toBe('100.00');
    expect((await app.core.wallets.get(walletId)).balance.amount).toBe('100.00');
    expect(await events(db.url, refund.transactionId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  test('ROLLBACK de WIN chega antes da WIN: espera e debita depois', async () => {
    const id = tagger();
    const { walletId, playerId } = await createWallet(app, '100.00');
    const rollback = await app.core.wagering.submit(
      command({ walletId, playerId, externalTransactionId: id('rb'), kind: Kind.Rollback, referenceExternalTransactionId: id('win'), money: money('40.00') }),
      httpCtx(),
    );
    expect(rollback.status).toBe(Status.PendingReference);
    await app.core.wagering.submit(command({ walletId, playerId, externalTransactionId: id('win'), kind: Kind.Win, money: money('40.00') }), httpCtx());
    await runWorker();
    expect((await app.core.wallets.getTransaction(rollback.transactionId)).status).toBe(Status.Processed);
    expect((await app.core.wallets.get(walletId)).balance.amount).toBe('100.00'); // 100 + 40 - 40
  });

  test('replay de uma transação pendente devolve o estado pendente (não processa de novo)', async () => {
    const id = tagger();
    const { walletId, playerId } = await createWallet(app, '100.00');
    const cmd = command({ walletId, playerId, externalTransactionId: id('rf-replay'), kind: Kind.Refund, referenceExternalTransactionId: id('nothing'), money: money('5.00') });
    const first = await app.core.wagering.submit(cmd, httpCtx());
    const second = await app.core.wagering.submit(cmd, httpCtx());
    expect(second).toMatchObject({ status: Status.PendingReference, idempotentReplay: true, transactionId: first.transactionId });
  });

  test('referência nunca chega: backoff exponencial e, no limite, REJECTED REFERENCE_NOT_FOUND + evento', async () => {
    const id = tagger();
    const { walletId, playerId } = await createWallet(app, '100.00');
    const refund = await app.core.wagering.submit(
      command({ walletId, playerId, externalTransactionId: id('rf-never'), kind: Kind.Refund, referenceExternalTransactionId: id('never'), money: money('10.00') }),
      httpCtx(),
    );
    const read = () => app.core.wallets.getTransaction(refund.transactionId);
    const t0 = clock.now().getTime();
    expect((await read()).nextAttemptAt!.getTime() - t0).toBe(POLICY.baseDelayMs); // 100ms

    // antes do vencimento o worker não toca na linha
    await runWorker();
    expect((await read()).pendingAttempts).toBe(0);

    clock.advance(POLICY.baseDelayMs);
    await runWorker();
    let tx = await read();
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.pendingAttempts).toBe(1);
    expect(tx.nextAttemptAt!.getTime() - clock.now().getTime()).toBe(POLICY.baseDelayMs * 2); // 200ms

    clock.advance(POLICY.baseDelayMs * 2);
    await runWorker();
    tx = await read();
    expect(tx.pendingAttempts).toBe(2);
    expect(tx.nextAttemptAt!.getTime() - clock.now().getTime()).toBe(POLICY.baseDelayMs * 4); // 400ms

    clock.advance(POLICY.baseDelayMs * 4);
    await runWorker(); // maxAttempts = 3: esgotou
    tx = await read();
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(await events(db.url, refund.transactionId)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
    expect((await app.core.wallets.get(walletId)).balance.amount).toBe('100.00');
    await runWorker();
    expect((await read()).pendingAttempts).toBe(tx.pendingAttempts); // terminal: nunca mais é reprocessada
  });

  test('referência chega mas já foi revertida -> REJECTED ALREADY_REVERSED após reprocessar', async () => {
    const id = tagger();
    const { walletId, playerId } = await createWallet(app, '100.00');
    const base = { walletId, playerId };
    // dois reembolsos concorrentes antes da BET
    const a = await app.core.wagering.submit(command({ ...base, externalTransactionId: id('rf-a'), kind: Kind.Refund, referenceExternalTransactionId: id('bet'), money: money('20.00') }), httpCtx());
    const b = await app.core.wagering.submit(command({ ...base, externalTransactionId: id('rf-b'), kind: Kind.Refund, referenceExternalTransactionId: id('bet'), money: money('20.00') }), httpCtx());
    expect([a.status, b.status]).toEqual([Status.PendingReference, Status.PendingReference]);
    await app.core.wagering.submit(command({ ...base, externalTransactionId: id('bet'), money: money('20.00') }), httpCtx());
    await runWorker();
    const [ta, tb] = await Promise.all([a, b].map((o) => app.core.wallets.getTransaction(o.transactionId)));
    const statuses = [ta!.status, tb!.status].sort();
    expect(statuses).toEqual([Status.Processed, Status.Rejected]);
    expect([ta, tb].find((t) => t!.status === Status.Rejected)!.failureCode).toBe(FailureCode.AlreadyReversed);
    expect((await app.core.wallets.get(walletId)).balance.amount).toBe('100.00'); // 100 - 20 (bet) + 20 (um refund)
  });

  test('erro permanente ao reprocessar vira FAILED (terminal e auditável), sem travar o worker', async () => {
    const id = tagger();
    const { walletId, playerId } = await createWallet(app, '100.00');
    const refund = await app.core.wagering.submit(
      command({ walletId, playerId, externalTransactionId: id('rf'), kind: Kind.Refund, referenceExternalTransactionId: id('bet'), money: money('10.00') }),
      httpCtx(),
    );
    await app.core.wagering.submit(command({ walletId, playerId, externalTransactionId: id('bet'), money: money('10.00') }), httpCtx());

    // instância com um defeito permanente (ex.: dado corrompido) ao travar a wallet
    const broken = await startTestApp(db.url, {
      clock,
      wrapUow: (uow): UnitOfWork => ({
        run: (work) =>
          uow.run((repos) =>
            work({
              ...repos,
              wallets: withOverrides(repos.wallets, {
                findByIdForUpdate: async () => {
                  throw new InvariantViolationError('dado corrompido (injetado)');
                },
              }),
            }),
          ),
        read: (work) => uow.read(work),
      }),
    });
    try {
      clock.advance(10_000);
      while (await broken.core.wagering.reprocessNextPending()) {
        /* cada linha problemática é marcada FAILED e o loop segue */
      }
    } finally {
      await broken.close();
    }
    const tx = await app.core.wallets.getTransaction(refund.transactionId);
    expect(tx.status).toBe(Status.Failed);
    expect(tx.failureCode).toBe(FailureCode.InternalPermanentError);
    expect(await app.core.wagering.reprocessNextPending()).toBe(false); // nada preso na fila
    expect((await app.core.wallets.get(walletId)).balance.amount).toBe('90.00'); // só a BET
  });
});
