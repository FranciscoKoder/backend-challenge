import { InvalidTransactionStateError, ValidationError } from '../../shared/domain/errors';
import { Money } from '../../shared/domain/money';
import { LedgerDirection } from '../../wallet/domain/wallet-ledger-entry';
import { FailureCode } from './failure-code';

export enum WagerTransactionKind {
  /** Interno: crédito de abertura da wallet. Nunca vem da API nem da fila. */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  /** Aceita, ainda não aplicada. */
  Pending = 'PENDING',
  /** Aguardando a transação referenciada (chegada fora de ordem). */
  PendingReference = 'PENDING_REFERENCE',
  /** Aplicada (terminal). */
  Processed = 'PROCESSED',
  /** Violação de regra de negócio (terminal). */
  Rejected = 'REJECTED',
  /** Erro permanente de infraestrutura (terminal, auditável). */
  Failed = 'FAILED',
}

/**
 * Transições válidas (qualquer outra lança InvalidTransactionStateError):
 *
 *   PENDING           -> PROCESSED | REJECTED | PENDING_REFERENCE | FAILED
 *   PENDING_REFERENCE -> PROCESSED | REJECTED | FAILED
 *   PROCESSED, REJECTED, FAILED são terminais.
 */
const TRANSITIONS: Readonly<Record<WagerTransactionStatus, readonly WagerTransactionStatus[]>> = {
  [WagerTransactionStatus.Pending]: [
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.PendingReference,
    WagerTransactionStatus.Failed,
  ],
  [WagerTransactionStatus.PendingReference]: [
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ],
  [WagerTransactionStatus.Processed]: [],
  [WagerTransactionStatus.Rejected]: [],
  [WagerTransactionStatus.Failed]: [],
};

/** Política de espera por referência: backoff exponencial limitado e número máximo de tentativas. */
export interface PendingReferencePolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export type ReferenceRetryResult = 'RETRY_SCHEDULED' | 'EXHAUSTED';

/** Tipos de transação que cada operação pode referenciar. */
const ALLOWED_REFERENCE_KINDS: Readonly<Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>>> = {
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  /** Saldo da wallet observado no momento do resultado (devolvido em replays). */
  resultBalance?: Money;
  pendingAttempts: number;
  nextAttemptAt?: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id no provedor — não o id interno */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _resultBalance?: Money,
    private _pendingAttempts: number = 0,
    private _nextAttemptAt?: Date,
  ) {}

  /** Nasce em PENDING. Valida a exigência de referência por kind. Rejeita `OPENING` (interno). */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new ValidationError('INVALID_KIND', 'OPENING é interno e não pode ser submetido');
    }
    return WagerTransaction.validated(props);
  }

  /** Transação interna de abertura da wallet; já nasce aplicada (PROCESSED). */
  static createOpening(
    props: Omit<CreateWagerTransactionProps, 'kind' | 'referenceExternalTransactionId'>,
    resultBalance: Money,
  ): WagerTransaction {
    const tx = WagerTransaction.validated({ ...props, kind: WagerTransactionKind.Opening });
    tx.markProcessed(undefined, props.createdAt, resultBalance);
    return tx;
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.resultBalance,
      state.pendingAttempts,
      state.nextAttemptAt,
    );
  }

  private static validated(props: CreateWagerTransactionProps): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new ValidationError('INVALID_AMOUNT', 'O valor da transação deve ser positivo');
    }
    const requires =
      props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    if (requires && !props.referenceExternalTransactionId) {
      throw new ValidationError(
        'MISSING_REFERENCE',
        `${props.kind} exige referenceExternalTransactionId`,
      );
    }
    if (
      props.referenceExternalTransactionId &&
      ALLOWED_REFERENCE_KINDS[props.kind] === undefined
    ) {
      throw new ValidationError('UNEXPECTED_REFERENCE', `${props.kind} não aceita referência`);
    }
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt,
      WagerTransactionStatus.Pending,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get resultBalance(): Money | undefined {
    return this._resultBalance;
  }
  get pendingAttempts(): number {
    return this._pendingAttempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  // ---- transições (lançam InvalidTransactionStateError se não permitidas / estado terminal)

  markProcessed(referenceTransactionId: string | undefined, at: Date, resultBalance?: Money): void {
    this.transitionTo(WagerTransactionStatus.Processed);
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._resultBalance = resultBalance;
    this._nextAttemptAt = undefined;
  }

  /** Referência ainda ausente: agenda a primeira nova tentativa conforme a política. */
  markPendingReference(now: Date, policy: PendingReferencePolicy): void {
    this.transitionTo(WagerTransactionStatus.PendingReference);
    this._pendingAttempts = 0;
    this._nextAttemptAt = new Date(now.getTime() + WagerTransaction.delayFor(0, policy));
  }

  /**
   * Registra uma tentativa de reprocessamento que ainda não achou a referência.
   * Devolve `EXHAUSTED` quando o limite acabou (o chamador deve então `reject`).
   */
  registerReferenceRetry(now: Date, policy: PendingReferencePolicy): ReferenceRetryResult {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(
        `Só PENDING_REFERENCE pode agendar nova tentativa (estado atual: ${this._status})`,
      );
    }
    this._pendingAttempts += 1;
    if (this._pendingAttempts >= policy.maxAttempts) {
      return 'EXHAUSTED';
    }
    this._nextAttemptAt = new Date(now.getTime() + WagerTransaction.delayFor(this._pendingAttempts, policy));
    return 'RETRY_SCHEDULED';
  }

  reject(code: FailureCode, resultBalance?: Money): void {
    this.transitionTo(WagerTransactionStatus.Rejected);
    this._failureCode = code;
    this._resultBalance = resultBalance;
    this._nextAttemptAt = undefined;
  }

  fail(code: FailureCode): void {
    this.transitionTo(WagerTransactionStatus.Failed);
    this._failureCode = code;
    this._nextAttemptAt = undefined;
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return TRANSITIONS[this._status].length === 0;
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  /** True para REFUND e ROLLBACK: operações que revertem outra transação. */
  isReversal(): boolean {
    return this.requiresReference();
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direção do lançamento. BET debita; WIN/REFUND/OPENING creditam;
   * ROLLBACK é o inverso do lançamento da referência (BET→crédito, WIN/REFUND→débito).
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidTransactionStateError('ROLLBACK precisa da referência para definir a direção');
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError('LOSS não gera lançamento');
    }
  }

  /**
   * Confere a coerência com a transação referenciada (a referência já foi resolvida e
   * está PROCESSED). Devolve o código de rejeição, ou `undefined` se válida.
   * Mesma regra para provider, player, wallet, moeda e rodada; valor igual em reversões.
   */
  checkReference(reference: WagerTransaction): FailureCode | undefined {
    if (
      reference.providerId !== this.providerId ||
      reference.playerId !== this.playerId ||
      reference.walletId !== this.walletId ||
      reference.money.currency !== this.money.currency ||
      reference.roundId !== this.roundId
    ) {
      return FailureCode.ReferenceMismatch;
    }
    const allowed = ALLOWED_REFERENCE_KINDS[this.kind] ?? [];
    if (!allowed.includes(reference.kind)) {
      return FailureCode.ReferenceKindInvalid;
    }
    if (this.isReversal() && !this.money.equals(reference.money)) {
      return FailureCode.AmountMismatch;
    }
    return undefined;
  }

  private transitionTo(next: WagerTransactionStatus): void {
    if (!TRANSITIONS[this._status].includes(next)) {
      throw new InvalidTransactionStateError(
        `Transição inválida ${this._status} -> ${next} (transação ${this.id})`,
      );
    }
    this._status = next;
  }

  private static delayFor(attempt: number, policy: PendingReferencePolicy): number {
    return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  }
}
