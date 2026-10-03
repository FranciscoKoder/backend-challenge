import type {
  InboxRepository,
  LedgerPage,
  LedgerReconciliation,
  LedgerRepository,
  OutboxRepository,
  Repositories,
  WagerTransactionRepository,
  WalletRepository,
} from '../../application/ports';
import { WalletAlreadyExistsError } from '../../application/ports';
import { InboxMessage } from '../../messaging/domain/inbox-message';
import { OutboxMessage } from '../../messaging/domain/outbox-message';
import { InvariantViolationError } from '../../shared/domain/errors';
import { Money } from '../../shared/domain/money';
import type { FailureCode } from '../../wagering/domain/failure-code';
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from '../../wagering/domain/wager-transaction';
import { Wallet } from '../../wallet/domain/wallet';
import {
  type LedgerDirection,
  WalletLedgerEntry,
} from '../../wallet/domain/wallet-ledger-entry';
import type { SqlExecutor } from './sql-executor';

type Row = Record<string, any>;

const orNull = <T>(value: T | undefined | null): T | null => (value === undefined ? null : value);

/**
 * O driver devolve `timestamptz` como string ("2026-10-03 12:26:48.576068-03"): normaliza
 * para `Date` (precisão de ms). Já recebendo `Date`, devolve o mesmo valor.
 */
export function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  const text = String(value).trim().replace(' ', 'T');
  const normalized = text.replace(/([+-]\d{2})$/, '$1:00').replace(/(\.\d{3})\d+/, '$1');
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) throw new Error(`timestamp inválido vindo do banco: ${String(value)}`);
  return date;
}
const toOptDate = (value: unknown): Date | undefined => (value == null ? undefined : toDate(value));
const money = (amount: string, currency: string): Money => Money.from({ amount, currency });
const optMoney = (amount: string | null, currency: string): Money | undefined =>
  amount === null ? undefined : money(amount, currency);

// ------------------------------------------------------------------ wallets

function toWallet(row: Row): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.player_id,
    currency: row.currency,
    balance: money(row.balance, row.currency),
    version: Number(row.version),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  });
}

class PgWalletRepository implements WalletRepository {
  constructor(private readonly db: SqlExecutor) {}

  async findById(id: string): Promise<Wallet | null> {
    const rows = await this.db.query('select * from wallets where id = ?', [id]);
    return rows[0] ? toWallet(rows[0]) : null;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | null> {
    // FOR NO KEY UPDATE: serializa quem altera o saldo, mas é compatível com o KEY SHARE que
    // as FKs (wager_transactions/ledger -> wallets) tomam. Com FOR UPDATE, duas transações
    // que já inseriram linhas filhas (KEY SHARE) e depois pedem o lock entram em deadlock.
    const rows = await this.db.query('select * from wallets where id = ? for no key update', [id]);
    return rows[0] ? toWallet(rows[0]) : null;
  }

  async insert(wallet: Wallet): Promise<void> {
    const rows = await this.db.query(
      `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)
       on conflict (player_id, currency) do nothing
       returning id`,
      [
        wallet.id,
        wallet.playerId,
        wallet.currency,
        wallet.balance.amount,
        wallet.version,
        wallet.createdAt,
        wallet.updatedAt,
      ],
    );
    if (rows.length === 0) {
      throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
    }
  }

  async updateBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    const rows = await this.db.query(
      `update wallets set balance = ?, version = ?, updated_at = ?
        where id = ? and version = ?
        returning id`,
      [wallet.balance.amount, wallet.version, wallet.updatedAt, wallet.id, expectedVersion],
    );
    if (rows.length === 0) {
      throw new InvariantViolationError(
        `Lost update evitado: wallet ${wallet.id} não está mais na versão ${expectedVersion}`,
      );
    }
  }
}

// ------------------------------------------------------------------ wager_transactions

function toTransaction(row: Row): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.provider_id,
    externalTransactionId: row.external_transaction_id,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    walletId: row.wallet_id,
    playerId: row.player_id,
    roundId: row.round_id,
    gameId: row.game_id,
    kind: row.kind as WagerTransactionKind,
    money: money(row.amount, row.currency),
    referenceExternalTransactionId: row.reference_external_transaction_id ?? undefined,
    createdAt: toDate(row.created_at),
    status: row.status as WagerTransactionStatus,
    referenceTransactionId: row.reference_transaction_id ?? undefined,
    failureCode: (row.failure_code ?? undefined) as FailureCode | undefined,
    processedAt: toOptDate(row.processed_at),
    resultBalance: optMoney(row.result_balance, row.currency),
    pendingAttempts: Number(row.pending_attempts),
    nextAttemptAt: toOptDate(row.next_attempt_at),
  });
}

class PgWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly db: SqlExecutor) {}

  async insertIfAbsent(tx: WagerTransaction): Promise<boolean> {
    const rows = await this.db.query(
      `insert into wager_transactions (
         id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, amount, currency,
         reference_external_transaction_id, reference_transaction_id,
         status, failure_code, result_balance, pending_attempts, next_attempt_at,
         created_at, processed_at, updated_at
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict do nothing
       returning id`,
      [
        tx.id,
        tx.providerId,
        tx.externalTransactionId,
        tx.idempotencyKey,
        tx.payloadHash,
        tx.walletId,
        tx.playerId,
        tx.roundId,
        tx.gameId,
        tx.kind,
        tx.money.amount,
        tx.money.currency,
        orNull(tx.referenceExternalTransactionId),
        orNull(tx.referenceTransactionId),
        tx.status,
        orNull(tx.failureCode),
        orNull(tx.resultBalance?.amount),
        tx.pendingAttempts,
        orNull(tx.nextAttemptAt),
        tx.createdAt,
        orNull(tx.processedAt),
        tx.createdAt,
      ],
    );
    return rows.length > 0;
  }

  async findById(id: string): Promise<WagerTransaction | null> {
    const rows = await this.db.query('select * from wager_transactions where id = ?', [id]);
    return rows[0] ? toTransaction(rows[0]) : null;
  }

  async findByProviderExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
    const rows = await this.db.query(
      'select * from wager_transactions where provider_id = ? and external_transaction_id = ?',
      [providerId, externalTransactionId],
    );
    return rows[0] ? toTransaction(rows[0]) : null;
  }

  async findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | null> {
    const rows = await this.db.query(
      'select * from wager_transactions where provider_id = ? and idempotency_key = ?',
      [providerId, idempotencyKey],
    );
    return rows[0] ? toTransaction(rows[0]) : null;
  }

  async findByIdForUpdate(id: string): Promise<WagerTransaction | null> {
    const rows = await this.db.query('select * from wager_transactions where id = ? for no key update', [id]);
    return rows[0] ? toTransaction(rows[0]) : null;
  }

  async save(tx: WagerTransaction, now: Date): Promise<void> {
    const rows = await this.db.query(
      `update wager_transactions
          set status = ?, reference_transaction_id = ?, failure_code = ?, processed_at = ?,
              result_balance = ?, pending_attempts = ?, next_attempt_at = ?, updated_at = ?
        where id = ?
        returning id`,
      [
        tx.status,
        orNull(tx.referenceTransactionId),
        orNull(tx.failureCode),
        orNull(tx.processedAt),
        orNull(tx.resultBalance?.amount),
        tx.pendingAttempts,
        orNull(tx.nextAttemptAt),
        now,
        tx.id,
      ],
    );
    if (rows.length === 0) {
      throw new InvariantViolationError(`Transação ${tx.id} não encontrada para atualização`);
    }
  }

  async lockDuePendingReference(now: Date, limit: number): Promise<WagerTransaction[]> {
    const rows = await this.db.query(
      `select * from wager_transactions
        where status = 'PENDING_REFERENCE' and next_attempt_at <= ?
        order by next_attempt_at
        limit ?
        for no key update skip locked`,
      [now, limit],
    );
    return rows.map(toTransaction);
  }

  async wakeDependents(providerId: string, referenceExternalTransactionId: string, now: Date): Promise<number> {
    // SKIP LOCKED: se um worker já está reprocessando o dependente, não bloqueamos (e não
    // criamos ciclo de locks transação -> wallet). Ele será retentado pelo backoff normal.
    const rows = await this.db.query(
      `update wager_transactions
          set next_attempt_at = ?, updated_at = ?
        where id in (
          select id from wager_transactions
           where status = 'PENDING_REFERENCE'
             and provider_id = ?
             and reference_external_transaction_id = ?
             and next_attempt_at > ?
           for no key update skip locked
        )
        returning id`,
      [now, now, providerId, referenceExternalTransactionId, now],
    );
    return rows.length;
  }

  async findProcessedReversalOf(referenceTransactionId: string): Promise<WagerTransaction | null> {
    const rows = await this.db.query(
      `select * from wager_transactions
        where reference_transaction_id = ? and kind in ('REFUND','ROLLBACK') and status = 'PROCESSED'
        limit 1`,
      [referenceTransactionId],
    );
    return rows[0] ? toTransaction(rows[0]) : null;
  }
}

// ------------------------------------------------------------------ ledger

function toLedgerEntry(row: Row): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: row.id,
    walletId: row.wallet_id,
    transactionId: row.transaction_id,
    direction: row.direction as LedgerDirection,
    money: money(row.amount, row.currency),
    balanceBefore: money(row.balance_before, row.currency),
    balanceAfter: money(row.balance_after, row.currency),
    createdAt: toDate(row.created_at),
  });
}

class PgLedgerRepository implements LedgerRepository {
  constructor(private readonly db: SqlExecutor) {}

  async insert(entry: WalletLedgerEntry): Promise<void> {
    await this.db.query(
      `insert into wallet_ledger_entries (
         id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.walletId,
        entry.transactionId,
        entry.direction,
        entry.money.amount,
        entry.money.currency,
        entry.balanceBefore.amount,
        entry.balanceAfter.amount,
        entry.createdAt,
      ],
    );
  }

  async list(walletId: string, afterSeq: string | null, limit: number): Promise<LedgerPage> {
    const rows =
      afterSeq === null
        ? await this.db.query(
            `select * from wallet_ledger_entries where wallet_id = ? order by seq asc limit ?`,
            [walletId, limit + 1],
          )
        : await this.db.query(
            `select * from wallet_ledger_entries where wallet_id = ? and seq > ?::bigint order by seq asc limit ?`,
            [walletId, afterSeq, limit + 1],
          );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      entries: page.map(toLedgerEntry),
      nextAfterSeq: hasMore ? String(page[page.length - 1]!.seq) : null,
    };
  }

  async findByTransaction(transactionId: string): Promise<WalletLedgerEntry[]> {
    const rows = await this.db.query(
      'select * from wallet_ledger_entries where transaction_id = ? order by seq',
      [transactionId],
    );
    return rows.map(toLedgerEntry);
  }

  async reconcile(walletId: string): Promise<LedgerReconciliation | null> {
    const rows = await this.db.query(
      `select w.balance as stored, w.currency as currency,
              coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)::numeric(18,2) as calculated,
              count(l.seq)::int as checked
         from wallets w
         left join wallet_ledger_entries l on l.wallet_id = w.id
        where w.id = ?
        group by w.id`,
      [walletId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      storedBalanceAmount: row.stored,
      currency: row.currency,
      calculatedAmount: row.calculated,
      checkedEntries: Number(row.checked),
    };
  }
}

// ------------------------------------------------------------------ inbox

function toInbox(row: Row): InboxMessage {
  return InboxMessage.rehydrate({
    messageId: row.message_id,
    consumerName: row.consumer_name,
    payloadHash: row.payload_hash,
    receivedAt: toDate(row.received_at),
    processedAt: toOptDate(row.processed_at),
  });
}

class PgInboxRepository implements InboxRepository {
  constructor(private readonly db: SqlExecutor) {}

  async tryReceive(message: InboxMessage): Promise<boolean> {
    const rows = await this.db.query(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at)
       values (?, ?, ?, ?)
       on conflict (consumer_name, message_id) do nothing
       returning message_id`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt],
    );
    return rows.length > 0;
  }

  async find(consumerName: string, messageId: string): Promise<InboxMessage | null> {
    const rows = await this.db.query(
      'select * from inbox_messages where consumer_name = ? and message_id = ?',
      [consumerName, messageId],
    );
    return rows[0] ? toInbox(rows[0]) : null;
  }

  async markProcessed(message: InboxMessage): Promise<void> {
    await this.db.query(
      'update inbox_messages set processed_at = ? where consumer_name = ? and message_id = ?',
      [orNull(message.processedAt), message.consumerName, message.messageId],
    );
  }
}

// ------------------------------------------------------------------ outbox

function toOutbox(row: Row): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: row.payload,
    occurredAt: toDate(row.occurred_at),
    attempts: Number(row.attempts),
    nextAttemptAt: toOptDate(row.next_attempt_at),
    publishedAt: toOptDate(row.published_at),
  });
}

class PgOutboxRepository implements OutboxRepository {
  constructor(private readonly db: SqlExecutor) {}

  async enqueue(message: OutboxMessage): Promise<void> {
    await this.db.query(
      `insert into outbox_messages (id, aggregate_id, ordering_key, event_type, payload, occurred_at, attempts, next_attempt_at)
       values (?, ?, ?, ?, ?::jsonb, ?, ?, ?)`,
      [
        message.id,
        message.aggregateId,
        message.orderingKey,
        message.eventType,
        JSON.stringify(message.payload),
        message.occurredAt,
        message.attempts,
        orNull(message.nextAttemptAt),
      ],
    );
  }

  async lockDue(now: Date, limit: number): Promise<Array<{ seq: string; message: OutboxMessage }>> {
    // Não pula a fila da wallet: se um evento anterior da mesma wallet está em backoff,
    // os seguintes esperam por ele (ordem por MessageGroupId preservada após falhas).
    const rows = await this.db.query(
      `select o.* from outbox_messages o
        where o.published_at is null
          and (o.next_attempt_at is null or o.next_attempt_at <= ?)
          and not exists (
            select 1 from outbox_messages p
             where p.ordering_key = o.ordering_key
               and p.published_at is null
               and p.seq < o.seq
               and p.next_attempt_at > ?
          )
        order by o.seq
        limit ?
        for update of o skip locked`,
      [now, now, limit],
    );
    return rows.map((row) => ({ seq: String(row.seq), message: toOutbox(row) }));
  }

  async markPublished(message: OutboxMessage): Promise<void> {
    await this.db.query(
      'update outbox_messages set published_at = ?, next_attempt_at = null, last_error = null where id = ?',
      [orNull(message.publishedAt), message.id],
    );
  }

  async recordFailure(message: OutboxMessage, error: string): Promise<void> {
    await this.db.query(
      'update outbox_messages set attempts = ?, next_attempt_at = ?, last_error = ? where id = ?',
      [message.attempts, orNull(message.nextAttemptAt), error.slice(0, 500), message.id],
    );
  }

  async stats(now: Date): Promise<{ pending: number; oldestAgeSeconds: number }> {
    const rows = await this.db.query(
      `select count(*)::int as pending,
              coalesce(extract(epoch from (?::timestamptz - min(occurred_at))), 0)::float8 as age
         from outbox_messages where published_at is null`,
      [now],
    );
    return { pending: Number(rows[0]?.pending ?? 0), oldestAgeSeconds: Math.max(0, Number(rows[0]?.age ?? 0)) };
  }
}

export function buildRepositories(db: SqlExecutor): Repositories {
  return {
    wallets: new PgWalletRepository(db),
    transactions: new PgWagerTransactionRepository(db),
    ledger: new PgLedgerRepository(db),
    inbox: new PgInboxRepository(db),
    outbox: new PgOutboxRepository(db),
  };
}
