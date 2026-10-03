import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { createOrm } from '../../src/infrastructure/persistence/orm';

/** Servidor PostgreSQL de testes (docker compose `postgres`). Sobrescreva com TEST_DATABASE_ADMIN_URL. */
export const ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';

export interface TestDatabase {
  name: string;
  url: string;
  drop(): Promise<void>;
}

function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

/** Cria um banco novo e vazio por arquivo de teste, com as migrations aplicadas. */
export async function createTestDatabase(options: { migrate?: boolean } = {}): Promise<TestDatabase> {
  const name = `wt_${randomBytes(6).toString('hex')}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`create database ${name} encoding 'UTF8' template template0`);
  } finally {
    await admin.end();
  }
  const url = withDatabase(ADMIN_URL, name);

  if (options.migrate !== false) {
    const orm = await createOrm({ databaseUrl: url, poolMax: 2 });
    try {
      await orm.getMigrator().up();
    } finally {
      await orm.close(true);
    }
  }

  return {
    name,
    url,
    async drop() {
      const c = new Client({ connectionString: ADMIN_URL });
      await c.connect();
      try {
        await c.query(`drop database if exists ${name} with (force)`);
      } finally {
        await c.end();
      }
    },
  };
}

/** Cliente `pg` direto, para asserts de schema e verificação independente do código sob teste. */
export async function withClient<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Invariante final de todos os testes: saldo gravado == saldo reconstruído pelo ledger,
 * para TODAS as wallets, e nenhum saldo negativo.
 */
export async function assertLedgerMatchesBalances(url: string): Promise<void> {
  await withClient(url, async (client) => {
    const { rows } = await client.query(`
      select w.id, w.balance::text as stored,
             coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)::numeric(18,2)::text as calculated
        from wallets w
        left join wallet_ledger_entries l on l.wallet_id = w.id
       group by w.id, w.balance
    `);
    const bad = rows.filter((r) => r.stored !== r.calculated || r.stored.startsWith('-'));
    if (bad.length > 0) {
      throw new Error(`Invariante violada (saldo != ledger): ${JSON.stringify(bad)}`);
    }
  });
}
