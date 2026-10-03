/** Base de todos os erros de domínio. `code` é estável e legível por máquina. */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Entrada que viola o contrato (formato, escala, moeda inválida...). Nunca é retentável. */
export class ValidationError extends DomainError {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export class InvalidMoneyError extends ValidationError {
  constructor(message: string) {
    super('INVALID_MONEY', message);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(expected: string, received: string) {
    super(`Moedas diferentes: esperado ${expected}, recebido ${received}`);
  }
}

/**
 * Tentativa de transicionar uma transação em estado terminal (ou transição inexistente).
 * É erro de programação, não caminho de negócio.
 */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';
}

export class InvariantViolationError extends DomainError {
  readonly code = 'INVARIANT_VIOLATION';
}
