import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { IdempotencyConflictError } from '../../src/application/errors';
import { FailureCode } from '../../src/wagering/domain/failure-code';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/wagering/domain/wager-transaction';
import { assertLedgerMatchesBalances, createTestDatabase, type TestDatabase, withClient } from '../support/database';
import { command, createWallet, httpCtx, money, startTestApp, type TestApp } from '../support/fixtures';

/**
 * Paralelismo real: três "instâncias" com pools de conexão independentes disparam
 * transações ao mesmo tempo contra o mesmo PostgreSQL. Nada é serializado no teste.
 */
describe('concorrência entre instâncias (pools independentes, mesmo PostgreSQL)', () => {
  let db: TestDatabase;
  let instances: TestApp[];
  const pick = (i: number) => instances[i % instances.length]!;

  beforeAll(async () => {
    db = await createTestDatabase();
    instances = await Promise.all([1, 2, 3].map(() => startTestApp(db.url, { poolMax: 20 })));
  });

  afterAll(async () => {
    await assertLedgerMatchesBalances(db.url);
    await Promise.all(instances.map((i) => i.close()));
    await db.drop();
  });

  const debits = (walletId: string) =>
    withClient(db.url, async (c) =>
      Number((await c.query(`select count(*) n from wallet_ledger_entries where wallet_id = $1 and direction = 'DEBIT'`, [walletId])).rows[0].n),
    );

  test('a mesma aposta enviada 50 vezes em paralelo gera um único débito', async () => {
    const { walletId, playerId } = await createWallet(pick(0), '1000.00');
    const same = command({ walletId, playerId, externalTransactionId: 'same-bet-x50', money: money('25.00') });

    const outcomes = await Promise.all(
      Array.from({ length: 50 }, (_, i) => pick(i).core.wagering.submit(same, httpCtx())),
    );

    expect(new Set(outcomes.map((o) => o.transactionId)).size).toBe(1);
    expect(outcomes.filter((o) => !o.idempotentReplay).length).toBe(1);
    expect(outcomes.filter((o) => o.idempotentReplay).length).toBe(49);
    expect(outcomes.every((o) => o.status === Status.Processed && o.balance?.amount === '975.00')).toBe(true);
    expect((await pick(0).core.wallets.get(walletId)).balance.amount).toBe('975.00');
    expect(await debits(walletId)).toBe(1);
  });

  test('cenário obrigatório (§8): 100.00 e duas apostas de 80.00 simultâneas, em instâncias diferentes', async () => {
    for (let round = 0; round < 10; round++) {
      const { walletId, playerId } = await createWallet(pick(round), '100.00');
      const [a, b] = await Promise.all([
        pick(0).core.wagering.submit(command({ walletId, playerId, money: money('80.00') }), httpCtx()),
        pick(1).core.wagering.submit(command({ walletId, playerId, money: money('80.00') }), httpCtx()),
      ]);
      const statuses = [a!.status, b!.status].sort();
      expect(statuses).toEqual([Status.Processed, Status.Rejected]);
      expect([a, b].find((o) => o!.status === Status.Rejected)!.failureCode).toBe(FailureCode.InsufficientFunds);
      expect((await pick(2).core.wallets.get(walletId)).balance.amount).toBe('20.00');
      expect(await debits(walletId)).toBe(1);

      // nenhum retry duplica o débito
      const retry = await pick(2).core.wagering.submit(
        command({ walletId, playerId, externalTransactionId: (await getExternal(a!.transactionId)), money: money('80.00') }),
        httpCtx(),
      ).catch((e) => e);
      expect(retry instanceof IdempotencyConflictError || retry.idempotentReplay === true).toBe(true);
      expect(await debits(walletId)).toBe(1);
    }
  });

  async function getExternal(transactionId: string): Promise<string> {
    return (await pick(0).core.wallets.getTransaction(transactionId)).externalTransactionId;
  }

  test('hot wallet: 100 apostas de 10.00 contra 500.00 → exatamente 50 aplicadas, saldo 0.00', async () => {
    const { walletId, playerId } = await createWallet(pick(0), '500.00');
    const outcomes = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        pick(i).core.wagering.submit(command({ walletId, playerId, money: money('10.00') }), httpCtx()),
      ),
    );
    expect(outcomes.filter((o) => o.status === Status.Processed).length).toBe(50);
    expect(outcomes.filter((o) => o.status === Status.Rejected).length).toBe(50);
    const wallet = await pick(1).core.wallets.get(walletId);
    expect(wallet.balance.amount).toBe('0.00');
    expect(wallet.version).toBe(51);
    expect(await debits(walletId)).toBe(50);
    // os saldos observados formam uma sequência sem buracos: 490, 480, ..., 0
    const observed = outcomes.filter((o) => o.status === Status.Processed).map((o) => o.balance!.amount).sort((x, y) => Number(x) - Number(y));
    expect(observed).toEqual(Array.from({ length: 50 }, (_, i) => `${i * 10}.00`));
  });

  test('créditos e débitos misturados na mesma wallet não perdem atualização (lost update)', async () => {
    const { walletId, playerId } = await createWallet(pick(0), '1000.00');
    const ops = Array.from({ length: 120 }, (_, i) =>
      i % 3 === 0
        ? command({ walletId, playerId, kind: Kind.Win, money: money('7.00') })
        : command({ walletId, playerId, money: money('3.00') }),
    );
    await Promise.all(ops.map((op, i) => pick(i).core.wagering.submit(op, httpCtx())));
    // 40 WIN de 7.00 e 80 BET de 3.00: 1000 + 280 - 240 = 1040
    expect((await pick(0).core.wallets.get(walletId)).balance.amount).toBe('1040.00');
    const r = await pick(1).core.wallets.reconcile(walletId);
    expect(r.consistent).toBe(true);
    expect(r.checkedEntries).toBe(121);
  });

  test('wallets distintas em paralelo: sem lock global, todas corretas', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, (_, i) => createWallet(pick(i), '100.00')));
    const started = performance.now();
    await Promise.all(
      wallets.flatMap((w, wi) =>
        Array.from({ length: 10 }, (_, j) =>
          pick(wi + j).core.wagering.submit(command({ ...w, money: money('5.00') }), httpCtx()),
        ),
      ),
    );
    const elapsed = performance.now() - started;
    for (const w of wallets) {
      expect((await pick(0).core.wallets.get(w.walletId)).balance.amount).toBe('50.00');
    }
    console.log(`200 transações em 20 wallets distintas: ${elapsed.toFixed(0)}ms`);
  });

  test('REFUND e ROLLBACK simultâneos da mesma BET: só uma reversão é aplicada', async () => {
    for (let round = 0; round < 5; round++) {
      const { walletId, playerId } = await createWallet(pick(0), '100.00');
      const bet = command({ walletId, playerId, money: money('40.00') });
      await pick(0).core.wagering.submit(bet, httpCtx());
      const ref = bet.externalTransactionId;
      const reversals = await Promise.all([
        pick(0).core.wagering.submit(command({ walletId, playerId, kind: Kind.Refund, referenceExternalTransactionId: ref, money: money('40.00') }), httpCtx()),
        pick(1).core.wagering.submit(command({ walletId, playerId, kind: Kind.Rollback, referenceExternalTransactionId: ref, money: money('40.00') }), httpCtx()),
        pick(2).core.wagering.submit(command({ walletId, playerId, kind: Kind.Refund, referenceExternalTransactionId: ref, money: money('40.00') }), httpCtx()),
      ]);
      expect(reversals.filter((r) => r.status === Status.Processed).length).toBe(1);
      expect(reversals.filter((r) => r.failureCode === FailureCode.AlreadyReversed).length).toBe(2);
      expect((await pick(0).core.wallets.get(walletId)).balance.amount).toBe('100.00');
    }
  });

  test('criação concorrente de wallet para o mesmo jogador: só uma vence', async () => {
    const playerId = `concurrent-player-${Date.now()}`;
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => pick(i).core.wallets.create({ playerId, initialBalance: money('10.00') }, 'c')),
    );
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    expect(results.filter((r) => r.status === 'rejected' && (r.reason as { code?: string }).code === 'WALLET_ALREADY_EXISTS').length).toBe(9);
  });
});
