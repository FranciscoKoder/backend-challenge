import { createHash } from 'node:crypto';
import { OutboxMessage } from '../messaging/domain/outbox-message';
import { type Clock, systemClock } from '../shared/domain/clock';
import { Money, type MoneyProps } from '../shared/domain/money';
import { uuidv7 } from '../shared/domain/uuid';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../wagering/domain/events';
import { WagerTransaction } from '../wagering/domain/wager-transaction';
import { Wallet } from '../wallet/domain/wallet';
import type { WalletLedgerEntry } from '../wallet/domain/wallet-ledger-entry';
import {
  InvalidCursorError,
  TransactionNotFoundError,
  WalletConflictError,
  WalletNotFoundError,
} from './errors';
import { type AppLogger, type Metrics, noopLogger, noopMetrics } from './observability';
import { type UnitOfWork, WalletAlreadyExistsError } from './ports';

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface LedgerPageView {
  entries: LedgerEntryView[];
  nextCursor: string | null;
}

export interface ReconciliationView {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

export const OPENING_PROVIDER = 'internal';

const toWalletView = (wallet: Wallet): WalletView => ({
  id: wallet.id,
  playerId: wallet.playerId,
  balance: wallet.balance.toJSON(),
  version: wallet.version,
});

const toEntryView = (entry: WalletLedgerEntry): LedgerEntryView => ({
  id: entry.id,
  transactionId: entry.transactionId,
  direction: entry.direction,
  money: entry.money.toJSON(),
  balanceBefore: entry.balanceBefore.toJSON(),
  balanceAfter: entry.balanceAfter.toJSON(),
  createdAt: entry.createdAt.toISOString(),
});

/** Cursor opaco e estável: o `seq` (identity) do último item, em base64url. */
export const encodeCursor = (seq: string): string => Buffer.from(JSON.stringify({ s: seq })).toString('base64url');

export function decodeCursor(cursor: string): string {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed?.s === 'string' && /^\d{1,19}$/.test(parsed.s)) return parsed.s;
  } catch {
    /* cai no erro abaixo */
  }
  throw new InvalidCursorError();
}

export class WalletService {
  private readonly clock: Clock;
  private readonly metrics: Metrics;
  private readonly logger: AppLogger;

  constructor(
    private readonly uow: UnitOfWork,
    options: { clock?: Clock; metrics?: Metrics; logger?: AppLogger } = {},
  ) {
    this.clock = options.clock ?? systemClock;
    this.metrics = options.metrics ?? noopMetrics;
    this.logger = options.logger ?? noopLogger;
  }

  /**
   * Cria a wallet. Com saldo inicial > 0, grava na MESMA transação SQL: a transação interna
   * `OPENING` (PROCESSED), o lançamento CREDIT correspondente e os eventos na outbox.
   */
  async create(input: { playerId: string; initialBalance: Money }, correlationId: string): Promise<WalletView> {
    const now = this.clock.now();
    const walletId = uuidv7(now.getTime());
    const openingTransactionId = uuidv7(now.getTime());
    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: input.playerId,
      initialBalance: input.initialBalance,
      opening: { transactionId: openingTransactionId, entryId: uuidv7(now.getTime()) },
      now,
    });

    try {
      await this.uow.run(async (repos) => {
        await repos.wallets.insert(wallet);
        if (!openingEntry) return;

        const externalId = `opening:${walletId}`;
        const opening = WagerTransaction.createOpening(
          {
            id: openingTransactionId,
            providerId: OPENING_PROVIDER,
            externalTransactionId: externalId,
            idempotencyKey: externalId,
            payloadHash: createHash('sha256').update(externalId).digest('hex'),
            walletId,
            playerId: input.playerId,
            roundId: 'opening',
            gameId: 'opening',
            money: input.initialBalance,
            createdAt: now,
          },
          wallet.balance,
        );
        await repos.transactions.insertIfAbsent(opening);
        await repos.ledger.insert(openingEntry);

        const ctx = () => ({ eventId: uuidv7(now.getTime()), correlationId, occurredAt: now });
        await repos.outbox.enqueue(OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, wallet, ctx())));
        await repos.outbox.enqueue(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, ctx())));
      });
    } catch (error) {
      if (error instanceof WalletAlreadyExistsError) {
        throw new WalletConflictError(input.playerId, input.initialBalance.currency);
      }
      throw error;
    }
    this.logger.info({ walletId, correlationId }, 'wallet criada');
    return toWalletView(wallet);
  }

  async get(walletId: string): Promise<WalletView> {
    const wallet = await this.uow.read((repos) => repos.wallets.findById(walletId));
    if (!wallet) throw new WalletNotFoundError(walletId);
    return toWalletView(wallet);
  }

  async listLedger(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPageView> {
    const afterSeq = cursor ? decodeCursor(cursor) : null;
    return this.uow.read(async (repos) => {
      if (!(await repos.wallets.findById(walletId))) throw new WalletNotFoundError(walletId);
      const page = await repos.ledger.list(walletId, afterSeq, limit);
      return {
        entries: page.entries.map(toEntryView),
        nextCursor: page.nextAfterSeq ? encodeCursor(page.nextAfterSeq) : null,
      };
    });
  }

  /**
   * Compara o saldo guardado com o reconstruído pelo ledger (ambos lidos em UMA instrução).
   * Divergência NÃO é corrigida: é logada, contabilizada em métrica e sinalizada na resposta.
   */
  async reconcile(walletId: string): Promise<ReconciliationView> {
    const result = await this.uow.read((repos) => repos.ledger.reconcile(walletId));
    if (!result) throw new WalletNotFoundError(walletId);

    const stored = Money.from({ amount: result.storedBalanceAmount, currency: result.currency });
    const calculated = Money.fromSigned({ amount: result.calculatedAmount, currency: result.currency });
    const difference = stored.subtract(calculated);
    const consistent = difference.isZero();
    if (!consistent) {
      this.metrics.reconciliationDivergence();
      this.logger.error(
        { walletId, checkedEntries: result.checkedEntries, differenceMinorUnits: difference.minorUnits.toString() },
        'DIVERGÊNCIA de reconciliação: saldo guardado difere do ledger',
      );
    }
    return {
      walletId,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: result.checkedEntries,
    };
  }

  async getTransaction(transactionId: string) {
    const tx = await this.uow.read((repos) => repos.transactions.findById(transactionId));
    if (!tx) throw new TransactionNotFoundError(transactionId);
    return tx;
  }

  async getTransactionByProvider(providerId: string, externalTransactionId: string) {
    const tx = await this.uow.read((repos) =>
      repos.transactions.findByProviderExternalId(providerId, externalTransactionId),
    );
    if (!tx) throw new TransactionNotFoundError(`${providerId}/${externalTransactionId}`);
    return tx;
  }
}
