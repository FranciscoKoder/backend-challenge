import { DomainError } from '../shared/domain/errors';

/** Mesma idempotency key (ou mesmo externalTransactionId) com payload diferente. Nunca é replay. */
export class IdempotencyConflictError extends DomainError {
  readonly code = 'IDEMPOTENCY_CONFLICT';

  constructor(
    readonly existingTransactionId: string,
    detail: string,
  ) {
    super(`Conflito de idempotência com a transação ${existingTransactionId}: ${detail}`);
  }
}

export class WalletNotFoundError extends DomainError {
  readonly code = 'WALLET_NOT_FOUND';

  constructor(walletId: string) {
    super(`Wallet ${walletId} não encontrada`);
  }
}

export class TransactionNotFoundError extends DomainError {
  readonly code = 'TRANSACTION_NOT_FOUND';

  constructor(reference: string) {
    super(`Transação ${reference} não encontrada`);
  }
}

export class WalletConflictError extends DomainError {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(playerId: string, currency: string) {
    super(`Já existe uma wallet para o jogador ${playerId} em ${currency}`);
  }
}

export class InvalidCursorError extends DomainError {
  readonly code = 'INVALID_CURSOR';

  constructor() {
    super('cursor inválido');
  }
}

/** A mesma mensagem (messageId) chegou com payload diferente: bug do produtor, não do canal. */
export class InboxPayloadConflictError extends DomainError {
  readonly code = 'INBOX_PAYLOAD_CONFLICT';

  constructor(consumerName: string, messageId: string) {
    super(`messageId ${messageId} já recebido por ${consumerName} com payload diferente`);
  }
}
