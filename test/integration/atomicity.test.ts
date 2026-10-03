import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Repositories } from '../../src/application/ports';
import { hashMessageBody } from '../../src/application/wager-processing.service';
import { FailureCode } from '../../src/wagering/domain/failure-code';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/wagering/domain/wager-transaction';
import { assertLedgerMatchesBalances, createTestDatabase, type TestDatabase, withClient } from '../support/database';
import {
  command,
  createWallet,
  failingUow,
  httpCtx,
  money,
  startTestApp,
  type TestApp,
} from '../support/fixtures';

const count = (url: string, table: string, where = 'true', params: unknown[] = []) =>
  withClient(url, async (c) => Number((await c.query(`select count(*) n from ${table} where ${where}`, params)).rows[0].n));

describe('atomicidade: wallet + ledger + inbox + outbox na mesma transação SQL', () => {
  let db: TestDatabase;
  let healthy: TestApp;

  beforeAll(async () => {
    db = await createTestDatabase();
    healthy = await startTestApp(db.url);
  });

  afterAll(async () => {
    await healthy.close();
    await db.drop();
  });

  test('se o evento da outbox não puder ser gravado, NADA é confirmado', async () => {
    const { walletId, playerId } = await createWallet(healthy, '100.00');
    const baselineLedger = await count(db.url, 'wallet_ledger_entries', 'wallet_id = $1', [walletId]);

    const faulty = await startTestApp(db.url, { wrapUow: (uow) => failingUow(uow, () => true) });
    try {
      await expect(
        faulty.core.wagering.submit(command({ walletId, playerId, externalTransactionId: 'atomic-1' }), {
          ...httpCtx(),
          source: 'sqs',
          inbox: { consumerName: 'c', messageId: 'm-atomic-1', messageHash: hashMessageBody('x') },
        }),
      ).rejects.toThrow('falha injetada na outbox');
    } finally {
      await faulty.close();
    }

    // saldo, ledger, transação e inbox: nenhum resquício
    expect((await healthy.core.wallets.get(walletId)).balance.amount).toBe('100.00');
    expect(await count(db.url, 'wallet_ledger_entries', 'wallet_id = $1', [walletId])).toBe(baselineLedger);
    expect(await count(db.url, 'wager_transactions', `external_transaction_id = 'atomic-1'`)).toBe(0);
    expect(await count(db.url, 'inbox_messages', `message_id = 'm-atomic-1'`)).toBe(0);
    expect(await count(db.url, 'outbox_messages', `payload->'data'->>'walletId' = $1 and event_type = 'WagerTransactionProcessed'`, [walletId])).toBe(1); // só o OPENING
    await assertLedgerMatchesBalances(db.url);
  });

  test('e depois da falha o mesmo pedido processa normalmente, sem débito duplicado', async () => {
    const { walletId, playerId } = await createWallet(healthy, '100.00');
    let fail = true;
    const flaky = await startTestApp(db.url, { wrapUow: (uow) => failingUow(uow, () => fail) });
    try {
      const cmd = command({ walletId, playerId, externalTransactionId: 'atomic-2', money: money('40.00') });
      await expect(flaky.core.wagering.submit(cmd, httpCtx())).rejects.toThrow();
      fail = false;
      const outcome = await flaky.core.wagering.submit(cmd, httpCtx());
      expect(outcome.status).toBe(WagerTransactionStatus.Processed);
      expect(outcome.idempotentReplay).toBe(false); // a primeira tentativa foi desfeita por completo
    } finally {
      await flaky.close();
    }
    expect((await healthy.core.wallets.get(walletId)).balance.amount).toBe('60.00');
    await assertLedgerMatchesBalances(db.url);
  });

  test('uma transação aplicada grava, juntos: transação, saldo, ledger e eventos', async () => {
    const { walletId, playerId } = await createWallet(healthy, '100.00');
    const outcome = await healthy.core.wagering.submit(
      command({ walletId, playerId, externalTransactionId: 'atomic-3', money: money('30.00') }),
      httpCtx('corr-atomic-3'),
    );
    await withClient(db.url, async (c) => {
      const events = await c.query(
        `select event_type, payload from outbox_messages where payload->'data'->>'transactionId' = $1 order by seq`,
        [outcome.transactionId],
      );
      expect(events.rows.map((r) => r.event_type)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
      const balanceChanged = events.rows[1].payload;
      expect(balanceChanged.correlationId).toBe('corr-atomic-3');
      expect(balanceChanged.data).toMatchObject({
        direction: 'DEBIT',
        money: { amount: '30.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '70.00', currency: 'BRL' },
        walletVersion: 2,
      });
    });
  });

  test('LOSS gera WagerTransactionProcessed mas NÃO gera WalletBalanceChanged nem muda a version', async () => {
    const { walletId, playerId } = await createWallet(healthy, '100.00');
    const outcome = await healthy.core.wagering.submit(
      command({ walletId, playerId, externalTransactionId: 'loss-1', kind: WagerTransactionKind.Loss, money: money('5.00') }),
      httpCtx(),
    );
    expect(outcome.status).toBe(WagerTransactionStatus.Processed);
    const types = await withClient(db.url, async (c) =>
      (await c.query(`select event_type from outbox_messages where payload->'data'->>'transactionId' = $1`, [outcome.transactionId])).rows.map((r) => r.event_type),
    );
    expect(types).toEqual(['WagerTransactionProcessed']);
    expect((await healthy.core.wallets.get(walletId)).version).toBe(1);
    expect(await count(db.url, 'wallet_ledger_entries', 'transaction_id = $1', [outcome.transactionId])).toBe(0);
  });

  test('rejeição grava a transação REJECTED e o evento, sem ledger e sem mexer no saldo', async () => {
    const { walletId, playerId } = await createWallet(healthy, '10.00');
    const outcome = await healthy.core.wagering.submit(
      command({ walletId, playerId, externalTransactionId: 'rej-1', money: money('10.01') }),
      httpCtx(),
    );
    expect(outcome.status).toBe(WagerTransactionStatus.Rejected);
    expect(outcome.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(outcome.balance?.amount).toBe('10.00');
    const types = await withClient(db.url, async (c) =>
      (await c.query(`select event_type from outbox_messages where payload->'data'->>'transactionId' = $1`, [outcome.transactionId])).rows.map((r) => r.event_type),
    );
    expect(types).toEqual(['WagerTransactionRejected']);
    expect(await count(db.url, 'wallet_ledger_entries', 'transaction_id = $1', [outcome.transactionId])).toBe(0);
    // a rejeição também é idempotente: reenviar devolve a mesma rejeição
    const again = await healthy.core.wagering.submit(
      command({ walletId, playerId, externalTransactionId: 'rej-1', money: money('10.01') }),
      httpCtx(),
    );
    expect(again).toMatchObject({ status: WagerTransactionStatus.Rejected, failureCode: FailureCode.InsufficientFunds, idempotentReplay: true });
  });

  test('criar wallet duplicada falha como conflito e não deixa lixo', async () => {
    const playerId = 'player-dup-wallet';
    await healthy.core.wallets.create({ playerId, initialBalance: money('50.00') }, 'c');
    await expect(healthy.core.wallets.create({ playerId, initialBalance: money('70.00') }, 'c')).rejects.toMatchObject({
      code: 'WALLET_ALREADY_EXISTS',
    });
    expect(await count(db.url, 'wallets', `player_id = $1`, [playerId])).toBe(1);
    // outra moeda para o mesmo jogador é uma wallet diferente
    await healthy.core.wallets.create({ playerId, initialBalance: money('1.00', 'USD') }, 'c');
    expect(await count(db.url, 'wallets', `player_id = $1`, [playerId])).toBe(2);
    await assertLedgerMatchesBalances(db.url);
  });

  test('transação desfeita pelo ROLLBACK do banco (UnitOfWork) não deixa efeitos parciais', async () => {
    const { walletId } = await createWallet(healthy, '100.00');
    await expect(
      healthy.core.uow.run(async (repos: Repositories) => {
        const wallet = (await repos.wallets.findByIdForUpdate(walletId))!;
        const before = wallet.version;
        wallet.credit({ transactionId: 'x', entryId: '00000000-0000-0000-0000-0000000000aa', money: money('1.00'), now: new Date() });
        await repos.wallets.updateBalance(wallet, before); // sem ledger: o COMMIT seria barrado, e aqui forçamos erro antes
        throw new Error('queda no meio');
      }),
    ).rejects.toThrow('queda no meio');
    expect((await healthy.core.wallets.get(walletId)).balance.amount).toBe('100.00');
  });
});
