import type { EntityManager } from '@mikro-orm/postgresql';

/** Executa SQL parametrizado (`?`) dentro da transação corrente do `EntityManager`. */
export interface SqlExecutor {
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export class MikroSqlExecutor implements SqlExecutor {
  constructor(private readonly em: EntityManager) {}

  async query<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const rows = await this.em
      .getConnection()
      .execute<T[]>(sql, params, 'all', this.em.getTransactionContext());
    return rows;
  }
}
