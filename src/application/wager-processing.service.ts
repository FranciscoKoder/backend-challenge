import { createHash } from 'node:crypto';
import { InboxMessage } from '../messaging/domain/inbox-message';
import { OutboxMessage } from '../messaging/domain/outbox-message';
import { type Clock, systemClock } from '../shared/domain/clock';
import { type MoneyProps } from '../shared/domain/money';
import { uuidv7 } from '../shared/domain/uuid';
import { FailureCode } from '../wagering/domain/failure-code';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../wagering/domain/events';
import {
  type PendingReferencePolicy,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../wagering/domain/wager-transaction';
import type { Wallet } from '../wallet/domain/wallet';
import type { WalletLedgerEntry } from '../wallet/domain/wallet-ledger-entry';
import type { EventContext, IntegrationEvent } from '../shared/domain/integration-event';
import {
  IdempotencyConflictError,
  InboxPayloadConflictError,
  WalletNotFoundError,
} from './errors';
import { type AppLogger, type Metrics, noopLogger, noopMetrics } from './observability';
import { ConcurrencyConflictError, type Repositories, TransientInfrastructureError, type UnitOfWork } from './ports';
import { type SubmitWagerCommand, computePayloadHash } from './wager-command';

export interface SubmitContext {
  correlationId: string;
  causationId?: string;
  source: 'http' | 'sqs';
  /** Quando a entrada vem do SQS: registra/consulta a inbox na MESMA transação. */
  inbox?: { consumerName: string; messageId: string; messageHash: string };
}

export interface WagerOutcome {
  transactionId: string;
  status: WagerTransactionStatus;
  failureCode?: FailureCode;
  /** Saldo observado no momento do resultado. Ausente enquanto PENDING_REFERENCE. */
  balance?: MoneyProps;
  idempotentReplay: boolean;
  /** SQS: a mensagem já havia sido processada antes (inbox). */
  duplicateMessage?: boolean;
}

interface ApplyEnv {
  ctx: Pick<SubmitContext, 'correlationId' | 'causationId'>;
  now: Date;
}

const MAX_CONFLICT_RETRIES = 6;

export interface WagerProcessingOptions {
  pendingPolicy: PendingReferencePolicy;
  clock?: Clock;
  metrics?: Metrics;
  logger?: AppLogger;
}

/**
 * Núcleo do processamento financeiro. HTTP, SQS e o worker de PENDING_REFERENCE usam
 * exatamente este código. A unidade de concorrência é a `walletId`: toda mutação de saldo
 * roda sob `SELECT ... FOR NO KEY UPDATE` da linha da wallet, dentro de UMA transação SQL que
 * também grava inbox, transação, ledger e outbox.
 */
export class WagerProcessingService {
  private readonly clock: Clock;
  private readonly metrics: Metrics;
  private readonly logger: AppLogger;
  private readonly policy: PendingReferencePolicy;

  constructor(
    private readonly uow: UnitOfWork,
    options: WagerProcessingOptions,
  ) {
    this.clock = options.clock ?? systemClock;
    this.metrics = options.metrics ?? noopMetrics;
    this.logger = options.logger ?? noopLogger;
    this.policy = options.pendingPolicy;
  }

  // ------------------------------------------------------------------ entrada (HTTP e SQS)

  async submit(command: SubmitWagerCommand, ctx: SubmitContext): Promise<WagerOutcome> {
    const startedAt = performance.now();
    const payloadHash = computePayloadHash(command);
    try {
      const outcome = await this.withConflictRetry(() =>
        this.uow.run((repos) => this.submitInTransaction(repos, command, payloadHash, ctx)),
      );
      if (outcome.idempotentReplay) {
        this.metrics.duplicateDetected(ctx.inbox ? 'inbox' : ctx.source);
      }
      return outcome;
    } catch (error) {
      if (error instanceof IdempotencyConflictError) this.metrics.idempotencyConflict();
      throw error;
    } finally {
      this.metrics.processingSeconds(ctx.source, (performance.now() - startedAt) / 1000);
    }
  }

  private async submitInTransaction(
    repos: Repositories,
    command: SubmitWagerCommand,
    payloadHash: string,
    ctx: SubmitContext,
  ): Promise<WagerOutcome> {
    const now = this.clock.now();

    // 1. Inbox: a duplicata de mensagem é detectada pelo banco, na mesma transação.
    let inbox: InboxMessage | undefined;
    if (ctx.inbox) {
      inbox = InboxMessage.receive({
        consumerName: ctx.inbox.consumerName,
        messageId: ctx.inbox.messageId,
        payloadHash: ctx.inbox.messageHash,
        receivedAt: now,
      });
      const received = await repos.inbox.tryReceive(inbox);
      if (!received) {
        return this.outcomeForDuplicateMessage(repos, command, ctx);
      }
    }

    // 2. Idempotência persistente: INSERT ... ON CONFLICT DO NOTHING nas unicidades do schema.
    const candidate = WagerTransaction.create({
      id: uuidv7(now.getTime()),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: command.money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: now,
    });

    let inserted: boolean;
    try {
      inserted = await repos.transactions.insertIfAbsent(candidate);
    } catch (error) {
      if (isForeignKeyViolation(error, 'wallet_id')) throw new WalletNotFoundError(command.walletId);
      throw error;
    }

    let outcome: WagerOutcome;
    if (!inserted) {
      outcome = await this.replayOrConflict(repos, command, payloadHash);
    } else {
      await this.apply(repos, candidate, { ctx, now });
      outcome = this.toOutcome(candidate, false);
      this.metrics.transactionOutcome(candidate.kind, candidate.status);
    }

    if (inbox) {
      inbox.markProcessed(now);
      await repos.inbox.markProcessed(inbox);
    }
    return outcome;
  }

  private async replayOrConflict(
    repos: Repositories,
    command: SubmitWagerCommand,
    payloadHash: string,
  ): Promise<WagerOutcome> {
    const byKey = await repos.transactions.findByIdempotencyKey(command.providerId, command.idempotencyKey);
    const existing =
      byKey ?? (await repos.transactions.findByProviderExternalId(command.providerId, command.externalTransactionId));
    if (!existing) {
      throw new ConcurrencyConflictError('Conflito de unicidade sem linha visível; refazer a transação');
    }
    if (existing.idempotencyKey !== command.idempotencyKey) {
      throw new IdempotencyConflictError(
        existing.id,
        'externalTransactionId já usado com outra Idempotency-Key',
      );
    }
    if (!existing.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError(existing.id, 'mesma Idempotency-Key com payload diferente');
    }
    return this.toOutcome(existing, true);
  }

  private async outcomeForDuplicateMessage(
    repos: Repositories,
    command: SubmitWagerCommand,
    ctx: SubmitContext,
  ): Promise<WagerOutcome> {
    const known = await repos.inbox.find(ctx.inbox!.consumerName, ctx.inbox!.messageId);
    if (known && known.payloadHash !== ctx.inbox!.messageHash) {
      throw new InboxPayloadConflictError(ctx.inbox!.consumerName, ctx.inbox!.messageId);
    }
    const existing = await repos.transactions.findByIdempotencyKey(command.providerId, command.idempotencyKey);
    if (!existing) {
      throw new ConcurrencyConflictError('Mensagem duplicada sem transação visível; refazer a transação');
    }
    return { ...this.toOutcome(existing, true), duplicateMessage: true };
  }

  // ------------------------------------------------------------------ reprocessamento

  /**
   * Reprocessa UMA transação PENDING_REFERENCE vencida. Uma transação SQL por linha:
   * trava a linha (SKIP LOCKED) e só então a wallet, sempre nessa ordem (sem deadlock).
   * Devolve `false` quando não há nada vencido.
   */
  async reprocessNextPending(): Promise<boolean> {
    const startedAt = performance.now();
    let claimedId: string | undefined;
    try {
      return await this.withConflictRetry(() =>
        this.uow.run(async (repos) => {
          const now = this.clock.now();
          const [claimed] = await repos.transactions.lockDuePendingReference(now, 1);
          if (!claimed) return false;
          claimedId = claimed.id;
          const env: ApplyEnv = { ctx: { correlationId: `pending-${claimed.id}`, causationId: claimed.id }, now };
          await this.apply(repos, claimed, env);
          if (claimed.status === WagerTransactionStatus.Processed) this.metrics.pendingReference('resolved');
          this.metrics.transactionOutcome(claimed.kind, claimed.status);
          return true;
        }),
      );
    } catch (error) {
      // Erro permanente (não transitório) ao reprocessar: sem isso a mesma linha voltaria a
      // cada ciclo para sempre (poison pill). Vira FAILED, terminal e auditável.
      if (claimedId && !(error instanceof TransientInfrastructureError)) {
        await this.markFailed(claimedId, error);
        return true;
      }
      throw error;
    } finally {
      this.metrics.processingSeconds('pending', (performance.now() - startedAt) / 1000);
    }
  }

  private async markFailed(transactionId: string, cause: unknown): Promise<void> {
    await this.uow.run(async (repos) => {
      const tx = await repos.transactions.findByIdForUpdate(transactionId);
      if (!tx || tx.isTerminal()) return;
      tx.fail(FailureCode.InternalPermanentError);
      await repos.transactions.save(tx, this.clock.now());
      this.metrics.transactionOutcome(tx.kind, tx.status);
    });
    this.logger.error(
      { transactionId, error: cause instanceof Error ? cause.message : String(cause) },
      'reprocessamento falhou de forma permanente; transação marcada como FAILED',
    );
  }

  // ------------------------------------------------------------------ regra de negócio

  /**
   * Aplica a transação (já persistida em PENDING ou PENDING_REFERENCE) e persiste o
   * resultado. Violações de regra NÃO lançam: viram `REJECTED` e fazem COMMIT, para que a
   * rejeição seja auditável e idempotente.
   */
  private async apply(repos: Repositories, tx: WagerTransaction, env: ApplyEnv): Promise<void> {
    const { now } = env;

    // Trava a wallet (exceto LOSS, que só lê). Daqui até o COMMIT ninguém altera o saldo.
    const lockStarted = performance.now();
    const wallet = tx.affectsBalance()
      ? await repos.wallets.findByIdForUpdate(tx.walletId)
      : await repos.wallets.findById(tx.walletId);
    const waited = (performance.now() - lockStarted) / 1000;
    this.metrics.walletLockWait(waited);
    if (waited > 0.05) this.metrics.lockConflict(); // esperou outra transação na mesma wallet
    if (!wallet) throw new WalletNotFoundError(tx.walletId);

    if (wallet.playerId !== tx.playerId) {
      return this.rejectTx(repos, tx, wallet, FailureCode.PlayerWalletMismatch, env);
    }
    if (wallet.currency !== tx.money.currency) {
      return this.rejectTx(repos, tx, wallet, FailureCode.CurrencyMismatch, env);
    }

    // Referência (obrigatória em REFUND/ROLLBACK, opcional em WIN/LOSS).
    let reference: WagerTransaction | undefined;
    if (tx.referenceExternalTransactionId) {
      const resolved = await this.resolveReference(repos, tx);
      if (resolved.kind === 'wait') {
        return this.waitForReference(repos, tx, wallet, env);
      }
      if (resolved.kind === 'reject') {
        return this.rejectTx(repos, tx, wallet, resolved.code, env);
      }
      reference = resolved.reference;
    }

    if (!tx.affectsBalance()) {
      // LOSS: registra o resultado, sem movimentar saldo, sem ledger, sem mudar version.
      return this.finishProcessed(repos, tx, wallet, reference, undefined, env);
    }

    const direction = tx.ledgerDirectionFor(reference);
    const prevVersion = wallet.version;
    const movement = { transactionId: tx.id, entryId: uuidv7(now.getTime()), money: tx.money, now };
    let entry: WalletLedgerEntry;
    if (direction === 'DEBIT') {
      if (!wallet.canDebit(tx.money)) {
        const code = tx.isReversal() ? FailureCode.ReversalWouldOverdraw : FailureCode.InsufficientFunds;
        return this.rejectTx(repos, tx, wallet, code, env);
      }
      entry = wallet.debit(movement);
    } else {
      entry = wallet.credit(movement);
    }

    await repos.wallets.updateBalance(wallet, prevVersion);
    await repos.ledger.insert(entry);
    await this.finishProcessed(repos, tx, wallet, reference, entry, env);
  }

  private async finishProcessed(
    repos: Repositories,
    tx: WagerTransaction,
    wallet: Wallet,
    reference: WagerTransaction | undefined,
    entry: WalletLedgerEntry | undefined,
    env: ApplyEnv,
  ): Promise<void> {
    const { now } = env;
    tx.markProcessed(reference?.id, now, wallet.balance);
    await repos.transactions.save(tx, now);

    await this.emit(repos, WagerTransactionProcessed.from(tx, wallet, this.eventContext(env)));
    if (entry) {
      await this.emit(repos, WalletBalanceChanged.from(wallet, entry, this.eventContext(env)));
    }
    // Adianta o reprocessamento de quem estava esperando por esta transação.
    if (
      tx.kind === WagerTransactionKind.Bet ||
      tx.kind === WagerTransactionKind.Win ||
      tx.kind === WagerTransactionKind.Refund
    ) {
      await repos.transactions.wakeDependents(tx.providerId, tx.externalTransactionId, now);
    }
  }

  private async rejectTx(
    repos: Repositories,
    tx: WagerTransaction,
    wallet: Wallet,
    code: FailureCode,
    env: ApplyEnv,
  ): Promise<void> {
    const { now } = env;
    tx.reject(code, wallet.balance);
    await repos.transactions.save(tx, now);
    await this.emit(
      repos,
      WagerTransactionRejected.from(tx, code, wallet.balance.toJSON(), this.eventContext(env)),
    );
    this.logger.info(
      { transactionId: tx.id, walletId: tx.walletId, providerId: tx.providerId, failureCode: code },
      'transação rejeitada por regra de negócio',
    );
  }

  private async waitForReference(
    repos: Repositories,
    tx: WagerTransaction,
    wallet: Wallet,
    env: ApplyEnv,
  ): Promise<void> {
    const { now } = env;
    if (tx.status === WagerTransactionStatus.Pending) {
      tx.markPendingReference(now, this.policy);
      await repos.transactions.save(tx, now);
      await this.emit(repos, WagerTransactionPendingReference.from(tx, this.eventContext(env)));
      this.logger.info(
        { transactionId: tx.id, walletId: tx.walletId, providerId: tx.providerId },
        'referência ausente: transação aguardando',
      );
      return;
    }
    // Já estava em PENDING_REFERENCE (reprocessamento): conta a tentativa.
    if (tx.registerReferenceRetry(now, this.policy) === 'EXHAUSTED') {
      this.metrics.pendingReference('exhausted');
      return this.rejectTx(repos, tx, wallet, FailureCode.ReferenceNotFound, env);
    }
    this.metrics.pendingReference('rescheduled');
    await repos.transactions.save(tx, now);
  }

  private async resolveReference(
    repos: Repositories,
    tx: WagerTransaction,
  ): Promise<
    | { kind: 'wait' }
    | { kind: 'reject'; code: FailureCode }
    | { kind: 'ok'; reference: WagerTransaction }
  > {
    const reference = await repos.transactions.findByProviderExternalId(
      tx.providerId,
      tx.referenceExternalTransactionId!,
    );
    if (
      !reference ||
      reference.status === WagerTransactionStatus.Pending ||
      reference.status === WagerTransactionStatus.PendingReference
    ) {
      return { kind: 'wait' };
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      return { kind: 'reject', code: FailureCode.ReferenceNotProcessed };
    }
    const mismatch = tx.checkReference(reference);
    if (mismatch) return { kind: 'reject', code: mismatch };
    if (tx.isReversal()) {
      const already = await repos.transactions.findProcessedReversalOf(reference.id);
      if (already) return { kind: 'reject', code: FailureCode.AlreadyReversed };
    }
    return { kind: 'ok', reference };
  }

  // ------------------------------------------------------------------ utilidades

  private async emit(
    repos: Repositories,
    event: IntegrationEvent<unknown>,
  ): Promise<void> {
    await repos.outbox.enqueue(OutboxMessage.enqueue(event));
  }

  private eventContext(env: ApplyEnv): EventContext {
    return {
      eventId: uuidv7(env.now.getTime()),
      correlationId: env.ctx.correlationId,
      causationId: env.ctx.causationId,
      occurredAt: env.now,
    };
  }

  private toOutcome(tx: WagerTransaction, replay: boolean): WagerOutcome {
    return {
      transactionId: tx.id,
      status: tx.status,
      ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
      ...(tx.resultBalance ? { balance: tx.resultBalance.toJSON() } : {}),
      idempotentReplay: replay,
    };
  }

  private async withConflictRetry<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await work();
      } catch (error) {
        if (error instanceof ConcurrencyConflictError && attempt < MAX_CONFLICT_RETRIES) {
          this.metrics.lockConflict();
          this.metrics.retry('db_conflict');
          await sleep(Math.min(200, 5 * 2 ** attempt) * (0.5 + Math.random()));
          continue;
        }
        throw error;
      }
    }
  }
}

function isForeignKeyViolation(error: unknown, columnHint: string): boolean {
  const e = error as { code?: string; constraint?: string; message?: string; cause?: any } | undefined;
  const code = e?.code ?? e?.cause?.code;
  const text = `${e?.constraint ?? e?.cause?.constraint ?? ''} ${e?.message ?? ''}`;
  return code === '23503' && text.includes(columnHint);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Hash de mensagem SQS (corpo bruto) para detectar reuso de messageId com conteúdo diferente. */
export function hashMessageBody(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}
