import { join } from 'node:path';
import { MikroORM } from '@mikro-orm/core';
import { Migrator } from '@mikro-orm/migrations';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';

export interface OrmOptions {
  databaseUrl: string;
  poolMax: number;
}

/**
 * MikroORM é usado como gerenciador de conexão/transação (`EntityManager.transactional`)
 * e como runner de migrations versionadas. O domínio NÃO é mapeado como entidade: os
 * repositórios gravam SQL explícito e reidratam via `rehydrate` (ver ARCHITECTURE.md).
 */
export async function createOrm(options: OrmOptions): Promise<MikroORM<PostgreSqlDriver>> {
  return MikroORM.init<PostgreSqlDriver>({
    driver: PostgreSqlDriver,
    clientUrl: options.databaseUrl,
    entities: [],
    discovery: { warnWhenNoEntities: false, requireEntitiesArray: false },
    extensions: [Migrator],
    pool: { min: 1, max: options.poolMax },
    allowGlobalContext: true,
    ensureDatabase: false,
    validateRequired: false,
    migrations: {
      path: join(import.meta.dirname, 'migrations'),
      pathTs: join(import.meta.dirname, 'migrations'),
      glob: 'Migration*.ts',
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      emit: 'ts',
      tableName: 'mikro_orm_migrations',
    },
  });
}
