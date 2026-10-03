import { CurrencyMismatchError, DomainError, InvariantViolationError } from '../../shared/domain/errors';
import { Money } from '../../shared/domain/money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';

  constructor(balance: Money, requested: Money) {
    super(`Saldo ${balance} insuficiente para debitar ${requested}`);
  }
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  /** Dados do lançamento de abertura, usados apenas se `initialBalance > 0`. */
  opening: { transactionId: string; entryId: string };
  now: Date;
}

export interface MovementProps {
  transactionId: string;
  entryId: string;
  money: Money;
  now: Date;
}

/**
 * Aggregate root. Toda alteração de saldo devolve o lançamento de ledger correspondente,
 * o que mantém saldo e ledger consistentes por construção.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Abre a wallet com `version = 1`. Se o saldo inicial for positivo, devolve também o
   * lançamento `CREDIT` de abertura (o saldo inicial nunca existe sem ledger).
   */
  static open(props: OpenWalletProps): { wallet: Wallet; openingEntry?: WalletLedgerEntry } {
    if (props.initialBalance.isNegative()) {
      throw new InvariantViolationError('Saldo inicial não pode ser negativo');
    }
    const currency = props.initialBalance.currency;
    const wallet = new Wallet(props.id, props.playerId, currency, props.initialBalance, 1, props.now, props.now);
    if (props.initialBalance.isZero()) {
      return { wallet };
    }
    const openingEntry = WalletLedgerEntry.create({
      id: props.opening.entryId,
      walletId: props.id,
      transactionId: props.opening.transactionId,
      direction: LedgerDirection.Credit,
      money: props.initialBalance,
      balanceBefore: Money.zero(currency),
      balanceAfter: props.initialBalance,
      createdAt: props.now,
    });
    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  /** Debita e devolve o lançamento. Lança `InsufficientFundsError` se o saldo não cobre. */
  debit(props: MovementProps): WalletLedgerEntry {
    this.assertMovable(props.money);
    if (!this.canDebit(props.money)) {
      throw new InsufficientFundsError(this._balance, props.money);
    }
    return this.apply(LedgerDirection.Debit, props, this._balance.subtract(props.money));
  }

  credit(props: MovementProps): WalletLedgerEntry {
    this.assertMovable(props.money);
    return this.apply(LedgerDirection.Credit, props, this._balance.add(props.money));
  }

  private apply(direction: LedgerDirection, props: MovementProps, next: Money): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore: this._balance,
      balanceAfter: next,
      createdAt: props.now,
    });
    this._balance = next;
    this._version += 1; // só incrementa quando o saldo muda
    this._updatedAt = props.now;
    return entry;
  }

  private assertMovable(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvariantViolationError('Movimentação exige valor positivo');
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
