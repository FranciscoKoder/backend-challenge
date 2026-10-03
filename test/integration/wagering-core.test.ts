import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { IdempotencyConflictError } from '../../src/application/errors';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/wagering/domain/wager-transaction';
import { FailureCode } from '../../src/wagering/domain/failure-code';
import { Money } from '../../src/shared/domain/money';
import {
  assertLedgerMatchesBalances,
  createTestDatabase,
  type TestDatabase,
  withClient,
} from '../support/database';
import { command, createWallet, httpCtx, money, startTestApp, type TestApp } from '../support/fixtures';

describe('processamento de transações (PostgreSQL real)', () => {
  let db: TestDatabase;
  let app: TestApp;

  beforeAll(async () => {
    db = await createTestDatabase();
    app = await startTestApp(db.url);
  });

  afterAll(async () => {
    await app.close();
    await db.drop();
  });

  test('BET debita, gera 1 lançamento e a transação fica PROCESSED', async () => {
    const { walletId, playerId } = await createWallet(app, '1000.00');
    const outcome = await app.core.wagering.submit(command({ walletId, playerId }), httpCtx());

    expect(outcome.status).toBe(WagerTransactionStatus.Processed);
    expect(outcome.balance).toEqual({ amount: '975.00', currency: 'BRL' });
    expect(outcome.idempotentReplay).toBe(false);

    const wallet = await app.core.wallets.get(walletId);
    expect(wallet.balance.amount).toBe('975.00');
    expect(wallet.version).toBe(2);
    const ledger = await app.core.wallets.listLedger(walletId, undefined, 50);
    expect(ledger.entries.map((e) => e.direction)).toEqual(['CREDIT', 'DEBIT']);
    await assertLedgerMatchesBalances(db.url);
  });

  test('replay devolve o resultado original (inclusive o saldo da época)', async () => {
    const { walletId, playerId } = await createWallet(app, '100.00');
    const first = await app.core.wagering.submit(command({ walletId, playerId, externalTransactionId: 'bet-1' }), httpCtx());
    await app.core.wagering.submit(command({ walletId, playerId, externalTransactionId: 'bet-2' }), httpCtx());

    const replay = await app.core.wagering.submit(
      command({ walletId, playerId, externalTransactionId: 'bet-1' }),
      httpCtx(),
    );
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(first.transactionId);
    expect(replay.balance).toEqual({ amount: '75.00', currency: 'BRL' }); // não os 50.00 atuais
    expect((await app.core.wallets.get(walletId)).balance.amount).toBe('50.00');
  });

  test('mesma key com payload diferente é conflito, não replay', async () => {
    const { walletId, playerId } = await createWallet(app, '100.00');
    await app.core.wagering.submit(command({ walletId, playerId, externalTransactionId: 'c-1' }), httpCtx());
    await expect(
      app.core.wagering.submit(
        command({ walletId, playerId, externalTransactionId: 'c-1', money: money('26.00') }),
        httpCtx(),
      ),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect((await app.core.wallets.get(walletId)).balance.amount).toBe('75.00');
  });

  test('cenário obrigatório: 80 + 80 contra 100 simultâneos', async () => {
    const { walletId, playerId } = await createWallet(app, '100.00');
    const results = await Promise.all(
      ['a', 'b'].map((id) =>
        app.core.wagering.submit(
          command({ walletId, playerId, externalTransactionId: `race-${id}`, money: money('80.00') }),
          httpCtx(),
        ),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected]);
    expect(results.find((r) => r.status === 'REJECTED')?.failureCode).toBe(FailureCode.InsufficientFunds);
    expect((await app.core.wallets.get(walletId)).balance.amount).toBe('20.00');

    const debits = await withClient(db.url, (c) =>
      c.query(`select count(*)::int n from wallet_ledger_entries where wallet_id = $1 and direction = 'DEBIT'`, [walletId]),
    );
    expect(debits.rows[0].n).toBe(1);
    await assertLedgerMatchesBalances(db.url);
  });

  test('WIN, LOSS e REFUND/ROLLBACK com referência', async () => {
    const { walletId, playerId } = await createWallet(app, '100.00');
    const base = { walletId, playerId };
    await app.core.wagering.submit(command({ ...base, externalTransactionId: 'b', money: money('30.00') }), httpCtx());
    const win = await app.core.wagering.submit(
      command({ ...base, externalTransactionId: 'w', kind: WagerTransactionKind.Win, money: money('60.00'), referenceExternalTransactionId: 'b' }),
      httpCtx(),
    );
    expect(win.balance?.amount).toBe('130.00');
    const loss = await app.core.wagering.submit(
      command({ ...base, externalTransactionId: 'l', kind: WagerTransactionKind.Loss, money: money('5.00'), roundId: 'round-1' }),
      httpCtx(),
    );
    expect(loss.status).toBe(WagerTransactionStatus.Processed);
    expect((await app.core.wallets.get(walletId)).version).toBe(3); // opening, bet, win (LOSS não muda)

    const rollbackWin = await app.core.wagering.submit(
      command({ ...base, externalTransactionId: 'rb', kind: WagerTransactionKind.Rollback, money: money('60.00'), referenceExternalTransactionId: 'w' }),
      httpCtx(),
    );
    expect(rollbackWin.balance?.amount).toBe('70.00');

    const refund = await app.core.wagering.submit(
      command({ ...base, externalTransactionId: 'rf', kind: WagerTransactionKind.Refund, money: money('30.00'), referenceExternalTransactionId: 'b' }),
      httpCtx(),
    );
    expect(refund.balance?.amount).toBe('100.00');

    const again = await app.core.wagering.submit(
      command({ ...base, externalTransactionId: 'rf2', kind: WagerTransactionKind.Rollback, money: money('30.00'), referenceExternalTransactionId: 'b' }),
      httpCtx(),
    );
    expect(again.failureCode).toBe(FailureCode.AlreadyReversed);
    await assertLedgerMatchesBalances(db.url);
  });

  test('reconciliação consistente', async () => {
    const { walletId, playerId } = await createWallet(app, '10.00');
    await app.core.wagering.submit(command({ walletId, playerId, money: Money.from({ amount: '4.00', currency: 'BRL' }) }), httpCtx());
    const r = await app.core.wallets.reconcile(walletId);
    expect(r.consistent).toBe(true);
    expect(r.checkedEntries).toBe(2);
    expect(r.difference.amount).toBe('0.00');
  });
});
