import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvariantViolationError } from '../../src/shared/domain/errors';
import { Money } from '../../src/shared/domain/money';
import { InsufficientFundsError, Wallet } from '../../src/wallet/domain/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../../src/wallet/domain/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const now = new Date('2026-07-29T15:00:00.000Z');

function openWallet(initial = '100.00') {
  return Wallet.open({
    id: 'w1',
    playerId: 'p1',
    initialBalance: brl(initial),
    opening: { transactionId: 't0', entryId: 'e0' },
    now,
  });
}

const move = (n: number, amount: string) => ({ transactionId: `t${n}`, entryId: `e${n}`, money: brl(amount), now });

describe('Wallet', () => {
  test('open: version 1 e lançamento CREDIT de abertura quando há saldo inicial', () => {
    const { wallet, openingEntry } = openWallet('1000.00');
    expect(wallet.balance.amount).toBe('1000.00');
    expect(wallet.version).toBe(1);
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.amount).toBe('0.00');
    expect(openingEntry?.balanceAfter.amount).toBe('1000.00');
  });

  test('open com saldo zero não gera lançamento', () => {
    const { wallet, openingEntry } = openWallet('0.00');
    expect(openingEntry).toBeUndefined();
    expect(wallet.version).toBe(1);
  });

  test('debit reduz o saldo, devolve o lançamento e incrementa a version', () => {
    const { wallet } = openWallet();
    const entry = wallet.debit(move(1, '30.00'));
    expect(wallet.balance.amount).toBe('70.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.amount).toBe('100.00');
    expect(entry.balanceAfter.amount).toBe('70.00');
    expect(entry.isBalanced()).toBe(true);
  });

  test('credit aumenta o saldo', () => {
    const { wallet } = openWallet();
    const entry = wallet.credit(move(1, '0.01'));
    expect(wallet.balance.amount).toBe('100.01');
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  test('saldo nunca fica negativo e nada muda quando o débito é recusado', () => {
    const { wallet } = openWallet('100.00');
    expect(() => wallet.debit(move(1, '100.01'))).toThrow(InsufficientFundsError);
    expect(wallet.balance.amount).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.debit(move(2, '100.00')).balanceAfter.amount).toBe('0.00'); // exatamente o saldo é permitido
  });

  test('moeda diferente da wallet é rejeitada', () => {
    const { wallet } = openWallet();
    const usd = { ...move(1, '1.00'), money: Money.from({ amount: '1.00', currency: 'USD' }) };
    expect(() => wallet.debit(usd)).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(usd)).toThrow(CurrencyMismatchError);
    expect(() => wallet.canDebit(usd.money)).toThrow(CurrencyMismatchError);
  });

  test('movimentação exige valor positivo', () => {
    const { wallet } = openWallet();
    expect(() => wallet.credit(move(1, '0.00'))).toThrow(InvariantViolationError);
  });

  test('rehydrate reconstrói o estado sem revalidar nem gerar lançamentos', () => {
    const wallet = Wallet.rehydrate({
      id: 'w9',
      playerId: 'p9',
      currency: 'BRL',
      balance: brl('5.00'),
      version: 7,
      createdAt: now,
      updatedAt: now,
    });
    expect(wallet.version).toBe(7);
    expect(wallet.balance.amount).toBe('5.00');
  });

  test('sequência de movimentos mantém saldo == soma dos lançamentos', () => {
    const { wallet, openingEntry } = openWallet('50.00');
    const entries = [openingEntry!];
    entries.push(wallet.debit(move(1, '12.34')));
    entries.push(wallet.credit(move(2, '100.00')));
    entries.push(wallet.debit(move(3, '0.01')));
    const sum = entries.reduce((acc, e) => acc.add(e.signedMoney), Money.zero('BRL'));
    expect(sum.equals(wallet.balance)).toBe(true);
    expect(wallet.version).toBe(4);
  });
});

describe('WalletLedgerEntry', () => {
  const base = {
    id: 'e',
    walletId: 'w',
    transactionId: 't',
    createdAt: now,
    money: brl('10.00'),
    balanceBefore: brl('50.00'),
  };

  test('create valida a aritmética do lançamento', () => {
    expect(() =>
      WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Debit, balanceAfter: brl('45.00') }),
    ).toThrow(InvariantViolationError);
    expect(() =>
      WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit, balanceAfter: brl('40.00') }),
    ).toThrow(InvariantViolationError);
    expect(
      WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit, balanceAfter: brl('60.00') }).isBalanced(),
    ).toBe(true);
  });

  test('não aceita saldo negativo nem valor não positivo', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        balanceBefore: brl('5.00'),
        direction: LedgerDirection.Debit,
        balanceAfter: brl('5.00').subtract(brl('10.00')),
      }),
    ).toThrow(InvariantViolationError);
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        money: brl('0.00'),
        direction: LedgerDirection.Credit,
        balanceAfter: brl('50.00'),
      }),
    ).toThrow(InvariantViolationError);
  });

  test('é estruturalmente imutável: sem métodos de mutação', () => {
    const entry = WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit, balanceAfter: brl('60.00') });
    const mutators = Object.getOwnPropertyNames(WalletLedgerEntry.prototype).filter((n) =>
      /^(set|mark|update|apply|change)/.test(n),
    );
    expect(mutators).toEqual([]);
    expect(entry.signedMoney.amount).toBe('10.00');
  });
});
