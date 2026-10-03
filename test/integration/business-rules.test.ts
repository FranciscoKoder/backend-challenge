import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { FailureCode } from '../../src/wagering/domain/failure-code';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/wagering/domain/wager-transaction';
import { assertLedgerMatchesBalances, createTestDatabase, type TestDatabase } from '../support/database';
import { command, createWallet, httpCtx, money, startTestApp, type TestApp } from '../support/fixtures';

describe('regras de negócio: REFUND, ROLLBACK e rejeições (PostgreSQL real)', () => {
  let db: TestDatabase;
  let app: TestApp;

  beforeAll(async () => {
    db = await createTestDatabase();
    app = await startTestApp(db.url);
  });

  afterAll(async () => {
    await assertLedgerMatchesBalances(db.url);
    await app.close();
    await db.drop();
  });

  /** Wallet nova com uma BET de 30.00 já processada (saldo 70.00). */
  async function withBet(initial = '100.00') {
    const { walletId, playerId } = await createWallet(app, initial);
    const base = { walletId, playerId };
    const tag = Math.random().toString(36).slice(2, 8);
    /** Ids de provedor são únicos por provider: cada teste usa o seu sufixo. */
    const id = (name: string) => `${name}-${tag}`;
    const bet = await app.core.wagering.submit(
      command({ ...base, externalTransactionId: id('bet'), money: money('30.00') }),
      httpCtx(),
    );
    const send = (over: Parameters<typeof command>[0] extends infer T ? Partial<T> : never) =>
      app.core.wagering.submit(command({ ...base, ...over } as never), httpCtx());
    const balance = async () => (await app.core.wallets.get(walletId)).balance.amount;
    return { ...base, bet, send, balance, id };
  }

  test('REFUND devolve o valor da BET e liga as transações', async () => {
    const t = await withBet();
    const refund = await t.send({ externalTransactionId: t.id('rf'), kind: Kind.Refund, referenceExternalTransactionId: t.id('bet'), money: money('30.00') });
    expect(refund.status).toBe(Status.Processed);
    expect(refund.balance?.amount).toBe('100.00');
    const view = await app.core.wallets.getTransaction(refund.transactionId);
    expect(view.referenceTransactionId).toBe(t.bet.transactionId);
  });

  test('REFUND/ROLLBACK da mesma BET só acontece uma vez, mesmo trocando o tipo', async () => {
    const t = await withBet();
    await t.send({ externalTransactionId: t.id('rf'), kind: Kind.Refund, referenceExternalTransactionId: t.id('bet'), money: money('30.00') });

    const refundAgain = await t.send({ externalTransactionId: t.id('rf2'), kind: Kind.Refund, referenceExternalTransactionId: t.id('bet'), money: money('30.00') });
    expect(refundAgain).toMatchObject({ status: Status.Rejected, failureCode: FailureCode.AlreadyReversed });

    const rollbackAfterRefund = await t.send({ externalTransactionId: t.id('rb'), kind: Kind.Rollback, referenceExternalTransactionId: t.id('bet'), money: money('30.00') });
    expect(rollbackAfterRefund).toMatchObject({ status: Status.Rejected, failureCode: FailureCode.AlreadyReversed });
    expect(await t.balance()).toBe('100.00'); // crédito aplicado uma única vez
  });

  test('ROLLBACK de BET credita; ROLLBACK de WIN debita; ROLLBACK de REFUND debita', async () => {
    const t = await withBet();
    const rollbackBet = await t.send({ externalTransactionId: t.id('rb-bet'), kind: Kind.Rollback, referenceExternalTransactionId: t.id('bet'), money: money('30.00') });
    expect(rollbackBet.balance?.amount).toBe('100.00');

    await t.send({ externalTransactionId: t.id('win'), kind: Kind.Win, money: money('50.00') });
    const rollbackWin = await t.send({ externalTransactionId: t.id('rb-win'), kind: Kind.Rollback, referenceExternalTransactionId: t.id('win'), money: money('50.00') });
    expect(rollbackWin.balance?.amount).toBe('100.00');

    await t.send({ externalTransactionId: t.id('bet2'), money: money('10.00') });
    await t.send({ externalTransactionId: t.id('rf2'), kind: Kind.Refund, referenceExternalTransactionId: t.id('bet2'), money: money('10.00') });
    const rollbackRefund = await t.send({ externalTransactionId: t.id('rb-rf'), kind: Kind.Rollback, referenceExternalTransactionId: t.id('rf2'), money: money('10.00') });
    expect(rollbackRefund.balance?.amount).toBe('90.00');
  });

  test('reversão que deixaria o saldo negativo é REJECTED com código próprio (≠ INSUFFICIENT_FUNDS)', async () => {
    const t = await withBet('100.00'); // saldo 70.00
    await t.send({ externalTransactionId: t.id('win'), kind: Kind.Win, money: money('50.00') }); // 120.00
    await t.send({ externalTransactionId: t.id('spend'), money: money('115.00') }); // 5.00
    const rollbackWin = await t.send({ externalTransactionId: t.id('rb-win'), kind: Kind.Rollback, referenceExternalTransactionId: t.id('win'), money: money('50.00') });
    expect(rollbackWin).toMatchObject({ status: Status.Rejected, failureCode: FailureCode.ReversalWouldOverdraw });
    expect(rollbackWin.failureCode).not.toBe(FailureCode.InsufficientFunds);
    expect(await t.balance()).toBe('5.00');
    // e continua auditável
    const stored = await app.core.wallets.getTransactionByProvider('provider-a', t.id('rb-win'));
    expect(stored.status).toBe(Status.Rejected);
  });

  test('valor diferente do da referência -> AMOUNT_MISMATCH (sem reversão parcial)', async () => {
    const t = await withBet();
    const r = await t.send({ externalTransactionId: t.id('rf'), kind: Kind.Refund, referenceExternalTransactionId: t.id('bet'), money: money('29.99') });
    expect(r).toMatchObject({ status: Status.Rejected, failureCode: FailureCode.AmountMismatch });
  });

  test('REFUND de uma WIN -> REFERENCE_KIND_INVALID', async () => {
    const t = await withBet();
    await t.send({ externalTransactionId: t.id('win'), kind: Kind.Win, money: money('5.00') });
    const r = await t.send({ externalTransactionId: t.id('rf'), kind: Kind.Refund, referenceExternalTransactionId: t.id('win'), money: money('5.00') });
    expect(r).toMatchObject({ status: Status.Rejected, failureCode: FailureCode.ReferenceKindInvalid });
  });

  test('referência de outra rodada, outro jogador ou outro provider -> REFERENCE_MISMATCH', async () => {
    const t = await withBet();
    const otherRound = await t.send({ externalTransactionId: t.id('rf-r'), kind: Kind.Refund, referenceExternalTransactionId: t.id('bet'), money: money('30.00'), roundId: 'round-2' });
    expect(otherRound.failureCode).toBe(FailureCode.ReferenceMismatch);

    // outro jogador (com a wallet dele) referenciando a BET do primeiro
    const other = await createWallet(app, '100.00');
    const otherPlayer = await app.core.wagering.submit(
      command({ ...other, externalTransactionId: t.id('rf-p'), kind: Kind.Refund, referenceExternalTransactionId: t.id('bet'), money: money('30.00') }),
      httpCtx(),
    );
    expect(otherPlayer.failureCode).toBe(FailureCode.ReferenceMismatch);

    // o mesmo ID de referência em outro provider é outra referência (aqui: inexistente -> fica pendente)
    const otherProvider = await t.send({ providerId: 'provider-b', externalTransactionId: t.id('rf-b'), kind: Kind.Refund, referenceExternalTransactionId: t.id('bet'), money: money('30.00') });
    expect(otherProvider.status).toBe(Status.PendingReference);
  });

  test('referência REJECTED não pode ser revertida -> REFERENCE_NOT_PROCESSED', async () => {
    const t = await withBet('10.00');
    const rejected = await t.send({ externalTransactionId: t.id('big'), money: money('999.00') });
    expect(rejected.status).toBe(Status.Rejected);
    const r = await t.send({ externalTransactionId: t.id('rf-big'), kind: Kind.Refund, referenceExternalTransactionId: t.id('big'), money: money('999.00') });
    expect(r).toMatchObject({ status: Status.Rejected, failureCode: FailureCode.ReferenceNotProcessed });
  });

  test('moeda da operação diferente da wallet -> CURRENCY_MISMATCH', async () => {
    const t = await withBet();
    const r = await t.send({ externalTransactionId: t.id('usd'), money: money('1.00', 'USD') });
    expect(r).toMatchObject({ status: Status.Rejected, failureCode: FailureCode.CurrencyMismatch });
    expect(await t.balance()).toBe('70.00');
  });

  test('playerId diferente do dono da wallet -> PLAYER_WALLET_MISMATCH', async () => {
    const t = await withBet();
    const r = await t.send({ externalTransactionId: t.id('thief'), playerId: 'someone-else' });
    expect(r).toMatchObject({ status: Status.Rejected, failureCode: FailureCode.PlayerWalletMismatch });
  });

  test('wallet inexistente é erro (404), não é persistido e não vira rejeição', async () => {
    await expect(
      app.core.wagering.submit(
        command({ walletId: '00000000-0000-7000-8000-000000000000', playerId: 'ghost', externalTransactionId: 'ghost-1' }),
        httpCtx(),
      ),
    ).rejects.toMatchObject({ code: 'WALLET_NOT_FOUND' });
  });

  test('WIN pode referenciar a BET da mesma rodada; referência inválida a rejeita', async () => {
    const t = await withBet();
    const ok = await t.send({ externalTransactionId: t.id('win-ref'), kind: Kind.Win, money: money('60.00'), referenceExternalTransactionId: t.id('bet') });
    expect(ok.status).toBe(Status.Processed);
    const wrongRound = await t.send({ externalTransactionId: t.id('win-ref2'), kind: Kind.Win, money: money('60.00'), referenceExternalTransactionId: t.id('bet'), roundId: 'round-9' });
    expect(wrongRound.failureCode).toBe(FailureCode.ReferenceMismatch);
  });

  test('saldo exato: apostar exatamente o saldo zera a wallet; um centavo a mais é rejeitado', async () => {
    const { walletId, playerId } = await createWallet(app, '10.00');
    const tooMuch = await app.core.wagering.submit(command({ walletId, playerId, money: money('10.01') }), httpCtx());
    expect(tooMuch.status).toBe(Status.Rejected);
    const exact = await app.core.wagering.submit(command({ walletId, playerId, money: money('10.00') }), httpCtx());
    expect(exact.balance?.amount).toBe('0.00');
  });
});
