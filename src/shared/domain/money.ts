import { CurrencyMismatchError, InvalidMoneyError } from './errors';

/** DTO de transporte: string decimal com escala fixa de 2 casas + moeda ISO-4217. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

const SCALE = 2;
const MINOR_PER_UNIT = 10n ** BigInt(SCALE);
/** Limite do `numeric(18,2)` do banco: 16 dígitos inteiros. */
const MAX_MINOR = 10n ** 18n - 1n;

const UNSIGNED_AMOUNT = /^\d+(\.\d{1,2})?$/;
const SIGNED_AMOUNT = /^-?\d+(\.\d{1,2})?$/;
const CURRENCY = /^[A-Z]{3}$/;

function assertCurrency(currency: unknown): asserts currency is string {
  if (typeof currency !== 'string' || !CURRENCY.test(currency)) {
    throw new InvalidMoneyError(`Moeda inválida (esperado ISO-4217, ex.: BRL): ${String(currency)}`);
  }
}

function parseMinor(amount: unknown, allowNegative: boolean): bigint {
  if (typeof amount !== 'string' || amount.length === 0) {
    throw new InvalidMoneyError('amount deve ser uma string decimal não vazia');
  }
  const pattern = allowNegative ? SIGNED_AMOUNT : UNSIGNED_AMOUNT;
  // Rejeita NaN, Infinity, notação científica, separador de milhar, espaços, sinal "+" e >2 casas.
  if (!pattern.test(amount)) {
    throw new InvalidMoneyError(
      `amount inválido "${amount}": use decimal com no máximo ${SCALE} casas${allowNegative ? '' : ', sem sinal'}`,
    );
  }
  const negative = amount.startsWith('-');
  const [intPart, fracPart = ''] = amount.replace('-', '').split('.');
  const minor = BigInt(intPart!) * MINOR_PER_UNIT + BigInt(fracPart.padEnd(SCALE, '0'));
  if (minor > MAX_MINOR) {
    throw new InvalidMoneyError(`amount fora do limite suportado: ${amount}`);
  }
  return negative ? -minor : minor;
}

/**
 * Dinheiro imutável. O valor é guardado em unidades menores (centavos) como `bigint`:
 * aritmética exata, sem `number`/float em nenhum ponto.
 */
export class Money {
  private constructor(
    private readonly minor: bigint,
    public readonly currency: string,
  ) {}

  /** Contrato de entrada: rejeita negativos, notação científica, NaN, vazio e >2 casas. */
  static from(props: MoneyProps): Money {
    assertCurrency(props?.currency);
    return new Money(parseMinor(props.amount, false), props.currency);
  }

  /** Para valores derivados que podem ser negativos (ex.: diferença de reconciliação). */
  static fromSigned(props: MoneyProps): Money {
    assertCurrency(props?.currency);
    return new Money(parseMinor(props.amount, true), props.currency);
  }

  static fromMinorUnits(minor: bigint, currency: string): Money {
    assertCurrency(currency);
    if (minor > MAX_MINOR || minor < -MAX_MINOR) {
      throw new InvalidMoneyError('valor fora do limite suportado');
    }
    return new Money(minor, currency);
  }

  static zero(currency: string): Money {
    assertCurrency(currency);
    return new Money(0n, currency);
  }

  get minorUnits(): bigint {
    return this.minor;
  }

  /** Decimal string com escala fixa de 2 casas. */
  get amount(): string {
    const negative = this.minor < 0n;
    const abs = negative ? -this.minor : this.minor;
    const units = abs / MINOR_PER_UNIT;
    const cents = (abs % MINOR_PER_UNIT).toString().padStart(SCALE, '0');
    return `${negative ? '-' : ''}${units}.${cents}`;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromMinorUnits(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromMinorUnits(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return new Money(-this.minor, this.currency);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
