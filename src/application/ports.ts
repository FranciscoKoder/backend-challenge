import type { InboxMessage } from '../messaging/domain/inbox-message';
import type { OutboxMessage } from '../messaging/domain/outbox-message';
import type { Wallet } from '../wallet/domain/wallet';
import type { WalletLedgerEntry } from '../wallet/domain/wallet-ledger-entry';
import type { WagerTransaction } from '../wagering/domain/wager-transaction';

// ------------------------------------------------------------------ erros de infraestrutura

/** Falha temporária (conexão, deadlock, timeout...): a operação inteira pode ser repetida. */
export class TransientInfrastructureError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TransientInfrastructureError';
  }
}

/**
 * Perdemos uma disputa de concorrência (deadlock, falha de serialização ou unicidade de
 * reversão): refazer a transação inteira do zero resolve.
 */
export class ConcurrencyConflictError extends TransientInfrastructureError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ConcurrencyConflictError';
  }
}

/** Violação de unicidade da wallet (`player_id`, `currency`). */
export class WalletAlreadyExistsError extends Error {
  constructor(playerId: string, currency: string) {
    super(`Já existe wallet para o jogador ${playerId} em ${currency}`);
    this.name = 'WalletAlreadyExistsError';
  }
}

// ------------------------------------------------------------------ repositórios

export interface WalletRepository {
  /** Lê sem travar (consultas e snapshots). */
  findById(id: string): Promise<Wallet | null>;
  /** `SELECT ... FOR NO KEY UPDATE`: serializa todas as mutações de saldo da wallet. */
  findByIdForUpdate(id: string): Promise<Wallet | null>;
  insert(wallet: Wallet): Promise<void>;
  /** Persiste o novo saldo/versão. Falha se a versão esperada não bater (defesa em profundidade). */
  updateBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface WagerTransactionRepository {
  /** `INSERT ... ON CONFLICT DO NOTHING`: devolve `true` se esta chamada criou a linha. */
  insertIfAbsent(tx: WagerTransaction): Promise<boolean>;
  findById(id: string): Promise<WagerTransaction | null>;
  findByProviderExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | null>;
  /** Trava a linha (`FOR NO KEY UPDATE`) para reprocessamento. */
  findByIdForUpdate(id: string): Promise<WagerTransaction | null>;
  /** Persiste mudanças de estado (status, referência, falha, tentativas...). */
  save(tx: WagerTransaction, now: Date): Promise<void>;
  /** Transações em PENDING_REFERENCE vencidas, travadas com `FOR NO KEY UPDATE SKIP LOCKED`. */
  lockDuePendingReference(now: Date, limit: number): Promise<WagerTransaction[]>;
  /** Antecipa o próximo reprocessamento dos dependentes de `(providerId, externalId)`. */
  wakeDependents(providerId: string, referenceExternalTransactionId: string, now: Date): Promise<number>;
  /** Alguma transação já reverteu (REFUND/ROLLBACK PROCESSED) esta referência? */
  findProcessedReversalOf(referenceTransactionId: string): Promise<WagerTransaction | null>;
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  /** `seq` do último item da página; `null` quando não há próxima página. */
  nextAfterSeq: string | null;
}

export interface LedgerReconciliation {
  storedBalanceAmount: string;
  currency: string;
  calculatedAmount: string;
  checkedEntries: number;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
  list(walletId: string, afterSeq: string | null, limit: number): Promise<LedgerPage>;
  findByTransaction(transactionId: string): Promise<WalletLedgerEntry[]>;
  /** Saldo guardado x saldo reconstruído pelo ledger, lidos em UMA instrução (um snapshot). */
  reconcile(walletId: string): Promise<LedgerReconciliation | null>;
}

export interface InboxRepository {
  /** Insere o registro; `false` se `(consumerName, messageId)` já existia. */
  tryReceive(message: InboxMessage): Promise<boolean>;
  find(consumerName: string, messageId: string): Promise<InboxMessage | null>;
  markProcessed(message: InboxMessage): Promise<void>;
}

export interface OutboxRepository {
  enqueue(message: OutboxMessage): Promise<void>;
  /** Mensagens devidas, travadas com `FOR UPDATE SKIP LOCKED` (múltiplos publishers). */
  lockDue(now: Date, limit: number): Promise<Array<{ seq: string; message: OutboxMessage }>>;
  markPublished(message: OutboxMessage): Promise<void>;
  recordFailure(message: OutboxMessage, error: string): Promise<void>;
  /** Pendências e idade da mais antiga (métrica de lag). */
  stats(now: Date): Promise<{ pending: number; oldestAgeSeconds: number }>;
}

export interface Repositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

/** Fronteira transacional: tudo que roda em `run` confirma junto ou não confirma. */
export interface UnitOfWork {
  run<T>(work: (repos: Repositories) => Promise<T>): Promise<T>;
  /** Leitura fora de transação explícita (consultas). */
  read<T>(work: (repos: Repositories) => Promise<T>): Promise<T>;
}

export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');

// ------------------------------------------------------------------ publicação de eventos

export interface EventPublisher {
  publish(message: OutboxMessage): Promise<void>;
  /**
   * Publica vários de uma vez (opcional). Devolve os ids que FALHARAM, com o motivo;
   * os demais foram aceitos pelo broker.
   */
  publishBatch?(messages: OutboxMessage[]): Promise<Map<string, string>>;
}

export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');
