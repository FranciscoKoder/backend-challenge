import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../../src/shared/domain/errors';
import { Money } from '../../src/shared/domain/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  test('serializa sempre com escala fixa de 2 casas', () => {
    expect(brl('25').amount).toBe('25.00');
    expect(brl('25.5').amount).toBe('25.50');
    expect(brl('0.05').amount).toBe('0.05');
    expect(brl('25.00').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(brl('1000000.00').toString()).toBe('1000000.00 BRL');
  });

  test('aritmética exata, sem erro de ponto flutuante', () => {
    expect(brl('0.10').add(brl('0.20')).amount).toBe('0.30'); // 0.1 + 0.2 != 0.3 em float
    expect(brl('100.00').subtract(brl('80.00')).amount).toBe('20.00');
    expect(brl('9007199254740993.00').add(brl('0.01')).amount).toBe('9007199254740993.01'); // > 2^53
    expect(brl('10.00').negate().amount).toBe('-10.00');
  });

  test('é imutável: operações devolvem novas instâncias', () => {
    const a = brl('10.00');
    const b = a.add(brl('5.00'));
    expect(a.amount).toBe('10.00');
    expect(b.amount).toBe('15.00');
    expect(b).not.toBe(a);
  });

  test('comparações e predicados', () => {
    expect(brl('0.00').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('1.00').subtract(brl('2.00')).isNegative()).toBe(true);
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.00').equals(brl('1'))).toBe(true);
    expect(brl('1.00').equals(Money.from({ amount: '1.00', currency: 'USD' }))).toBe(false);
    expect(Money.zero('BRL').amount).toBe('0.00');
  });

  test.each([
    ['', 'vazio'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['1e3', 'notação científica'],
    ['1E3', 'notação científica maiúscula'],
    ['0x10', 'hexadecimal'],
    ['1.234', 'mais de 2 casas'],
    ['1.', 'ponto sem fração'],
    ['.5', 'sem parte inteira'],
    ['-1.00', 'negativo em contrato de entrada'],
    ['+1.00', 'sinal explícito'],
    [' 1.00', 'espaço'],
    ['1,00', 'vírgula decimal'],
    ['1_000.00', 'separador'],
    ['99999999999999999.00', 'acima do limite do numeric(18,2)'],
  ])('rejeita amount inválido %p (%s)', (amount) => {
    expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test('rejeita amount que não é string (nunca aceita number)', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: null as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test.each(['brl', 'BR', 'BRLL', '', '123'])('rejeita moeda inválida %p', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });

  test('operações entre moedas diferentes lançam erro de domínio', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
  });

  test('fromSigned aceita negativos (diferenças de reconciliação)', () => {
    expect(Money.fromSigned({ amount: '-5.00', currency: 'BRL' }).isNegative()).toBe(true);
    expect(() => Money.fromSigned({ amount: '--5.00', currency: 'BRL' })).toThrow(InvalidMoneyError);
  });
});
