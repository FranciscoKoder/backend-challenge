/**
 * Taxonomia de códigos de falha. Cada código é estável, legível por máquina e carrega
 * a orientação para o provedor (o que fazer depois de receber a rejeição).
 */
export enum FailureCode {
  /** BET maior que o saldo disponível. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** ROLLBACK que debitaria mais do que o saldo atual (ex.: reverter um WIN já gasto). */
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  /** A transação referenciada nunca chegou dentro do limite de tentativas. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** A referência existe, mas foi REJECTED/FAILED: não há efeito a reverter. */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** Provider, player, wallet, moeda ou rodada diferentes da referência. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** O tipo da referência não é aceito (ex.: REFUND apontando para WIN). */
  ReferenceKindInvalid = 'REFERENCE_KIND_INVALID',
  /** O valor difere do da referência (reversão parcial não é suportada). */
  AmountMismatch = 'AMOUNT_MISMATCH',
  /** A referência já foi revertida. */
  AlreadyReversed = 'ALREADY_REVERSED',
  /** A moeda da operação difere da moeda da wallet. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** O playerId informado não é o dono da wallet. */
  PlayerWalletMismatch = 'PLAYER_WALLET_MISMATCH',
  /** Erro permanente de infraestrutura/dados (estado FAILED). */
  InternalPermanentError = 'INTERNAL_PERMANENT_ERROR',
}

export type ProviderAdvice =
  | 'GIVE_UP' // o resultado é definitivo; reenviar produz a mesma rejeição
  | 'FIX_PAYLOAD' // corrigir o payload e reenviar com NOVA idempotency key
  | 'CONTACT_SUPPORT'; // exige análise operacional

export const FAILURE_ADVICE: Readonly<Record<FailureCode, ProviderAdvice>> = {
  [FailureCode.InsufficientFunds]: 'GIVE_UP',
  [FailureCode.ReversalWouldOverdraw]: 'CONTACT_SUPPORT',
  [FailureCode.ReferenceNotFound]: 'FIX_PAYLOAD',
  [FailureCode.ReferenceNotProcessed]: 'GIVE_UP',
  [FailureCode.ReferenceMismatch]: 'FIX_PAYLOAD',
  [FailureCode.ReferenceKindInvalid]: 'FIX_PAYLOAD',
  [FailureCode.AmountMismatch]: 'FIX_PAYLOAD',
  [FailureCode.AlreadyReversed]: 'GIVE_UP',
  [FailureCode.CurrencyMismatch]: 'FIX_PAYLOAD',
  [FailureCode.PlayerWalletMismatch]: 'FIX_PAYLOAD',
  [FailureCode.InternalPermanentError]: 'CONTACT_SUPPORT',
};
