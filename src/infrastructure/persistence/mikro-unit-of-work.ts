import type { MikroORM } from '@mikro-orm/core';
import type { EntityManager, PostgreSqlDriver } from '@mikro-orm/postgresql';
import type { Repositories, UnitOfWork } from '../../application/ports';
import { ConcurrencyConflictError, TransientInfrastructureError } from '../../application/ports';
import { isRetryableConflict, isTransientDbError, isUniqueViolation } from './pg-errors';
import { buildRepositories } from './pg-repositories';
import { MikroSqlExecutor } from './sql-executor';

/**
 * Unit of Work sobre `EntityManager.transactional()`: BEGIN/COMMIT/ROLLBACK reais do
 * PostgreSQL (READ COMMITTED). Qualquer exceção desfaz TUDO: wallet, ledger, inbox, outbox.
 */
export class MikroUnitOfWork implements UnitOfWork {
  constructor(private readonly orm: MikroORM<PostgreSqlDriver>) {}

  async run<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    try {
      const em = this.orm.em.fork() as EntityManager;
      return await em.transactional(async (tx) => work(buildRepositories(new MikroSqlExecutor(tx as EntityManager))));
    } catch (error) {
      throw this.classify(error);
    }
  }

  async read<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    try {
      const em = this.orm.em.fork() as EntityManager;
      return await work(buildRepositories(new MikroSqlExecutor(em)));
    } catch (error) {
      throw this.classify(error);
    }
  }

  /** Traduz indisponibilidade/conflito do banco em erro transitório; preserva o resto. */
  private classify(error: unknown): unknown {
    if (error instanceof TransientInfrastructureError) return error;
    if (isRetryableConflict(error) || isUniqueViolation(error, 'uq_wager_tx_one_reversal_per_reference')) {
      return new ConcurrencyConflictError('Conflito de concorrência no PostgreSQL', { cause: error });
    }
    if (isTransientDbError(error)) {
      return new TransientInfrastructureError('PostgreSQL indisponível ou em conflito retentável', { cause: error });
    }
    return error;
  }
}
