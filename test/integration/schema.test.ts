import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Client } from 'pg';
import { createOrm } from '../../src/infrastructure/persistence/orm';
import { createTestDatabase, type TestDatabase, withClient } from '../support/database';

/** Roda SQL cru e devolve o código SQLSTATE do erro (ou `ok`). */
async function sqlState(client: Client, sql: string, params: unknown[] = []): Promise<string> {
  try {
    await client.query(sql, params);
    return 'ok';
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown';
  }
}

const UNIQUE = '23505';
const CHECK = '23514';
const FK = '23503';
const OBJECT_STATE = '55000'; // nossas triggers de imutabilidade

const T = '2026-07-29T15:00:00Z';
const HASH = 'a'.repeat(64);

describe('schema: constraints, índices e triggers (PostgreSQL real)', () => {
  let db: TestDatabase;
  let client: Client;

  // Saldo != 0 só é válido junto de um lançamento na mesma transação (trigger deferida).
  const wallet = (id: string, player = `p-${id}`, balance = '0.00') =>
    client.query(
      `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
       values ($1, $2, 'BRL', $3, 1, $4, $4)`,
      [id, player, balance, T],
    );

  const ID = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

  const tx = (
    id: string,
    walletId: string,
    overrides: Partial<Record<string, string | null>> = {},
  ) => {
    const v = {
      provider: 'provider-a',
      external: `ext-${id}`,
      key: `key-${id}`,
      kind: 'BET',
      status: 'PENDING',
      ref: null as string | null,
      refId: null as string | null,
      ...overrides,
    };
    return client.query(
      `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id,
         reference_transaction_id, status, failure_code, result_balance, processed_at, next_attempt_at, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,'p','r','g',$7,10.00,'BRL',$8,$9,$10,
         case when $10 in ('REJECTED','FAILED') then 'X' end,
         case when $10 = 'PROCESSED' then 10.00 end,
         case when $10 = 'PROCESSED' then $11::timestamptz end,
         case when $10 = 'PENDING_REFERENCE' then $11::timestamptz end,
         $11, $11)`,
      [id, v.provider, v.external, v.key, HASH, walletId, v.kind, v.ref, v.refId, v.status, T],
    );
  };

  const ledger = (id: string, walletId: string, txId: string, dir: string, amount: string, before: string, after: string) =>
    client.query(
      `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       values ($1,$2,$3,$4,$5,'BRL',$6,$7,$8)`,
      [id, walletId, txId, dir, amount, before, after, T],
    );

  beforeAll(async () => {
    db = await createTestDatabase();
    const { Client } = await import('pg');
    client = new Client({ connectionString: db.url });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
    await db.drop();
  });

  test('uma wallet por (playerId, currency)', async () => {
    await client.query(
      `insert into wallets values ($1,'dup-player','BRL',0,1,$2,$2)`,
      [ID(1), T],
    );
    expect(
      await sqlState(client, `insert into wallets values ($1,'dup-player','BRL',0,1,$2,$2)`, [ID(2), T]),
    ).toBe(UNIQUE);
    expect(
      await sqlState(client, `insert into wallets values ($1,'dup-player','USD',0,1,$2,$2)`, [ID(3), T]),
    ).toBe('ok');
  });

  test('saldo nunca negativo (CHECK)', async () => {
    expect(
      await sqlState(client, `insert into wallets values ($1,'neg','BRL',-0.01,1,$2,$2)`, [ID(10), T]),
    ).toBe(CHECK);
  });

  test('moeda e version inválidas são rejeitadas', async () => {
    expect(await sqlState(client, `insert into wallets values ($1,'c1','br',0,1,$2,$2)`, [ID(11), T])).toBe(CHECK);
    expect(await sqlState(client, `insert into wallets values ($1,'c2','BRL',0,0,$2,$2)`, [ID(12), T])).toBe(CHECK);
  });

  test('saldo usa numeric exato (sem float)', async () => {
    const { rows } = await client.query(
      `select (0.10::numeric(18,2) + 0.20::numeric(18,2))::text as sum, pg_typeof(balance)::text as type
         from (select 0::numeric(18,2) as balance) x`,
    );
    expect(rows[0].sum).toBe('0.30');
    const col = await client.query(
      `select data_type, numeric_precision, numeric_scale from information_schema.columns
        where table_name = 'wallets' and column_name = 'balance'`,
    );
    expect(col.rows[0]).toMatchObject({ data_type: 'numeric', numeric_precision: 18, numeric_scale: 2 });
  });

  test('transação: unicidade por (provider, externalTransactionId) e por (provider, idempotencyKey)', async () => {
    await wallet(ID(20));
    await tx(ID(21), ID(20), { external: 'e-1', key: 'k-1' });
    expect(await sqlState(client, `select 1`)).toBe('ok');
    // mesmo externalTransactionId, outra chave
    await expect(tx(ID(22), ID(20), { external: 'e-1', key: 'k-2' })).rejects.toMatchObject({ code: UNIQUE });
    // mesma chave, outro externalTransactionId
    await expect(tx(ID(23), ID(20), { external: 'e-3', key: 'k-1' })).rejects.toMatchObject({ code: UNIQUE });
    // outro provider pode reutilizar os mesmos ids
    await tx(ID(24), ID(20), { provider: 'provider-b', external: 'e-1', key: 'k-1' });
  });

  test('transação exige wallet existente (FK) e kind/status válidos', async () => {
    await expect(tx(ID(30), ID(999))).rejects.toMatchObject({ code: FK });
    await wallet(ID(31));
    await expect(tx(ID(32), ID(31), { kind: 'TIP' })).rejects.toMatchObject({ code: CHECK });
    await expect(tx(ID(33), ID(31), { status: 'DONE' })).rejects.toMatchObject({ code: CHECK });
  });

  test('REFUND e ROLLBACK exigem referência do provedor (CHECK)', async () => {
    await wallet(ID(40));
    await expect(tx(ID(41), ID(40), { kind: 'REFUND' })).rejects.toMatchObject({ code: CHECK });
    await expect(tx(ID(42), ID(40), { kind: 'ROLLBACK' })).rejects.toMatchObject({ code: CHECK });
    await tx(ID(43), ID(40), { kind: 'REFUND', ref: 'x' });
  });

  test('uma referência só é revertida uma vez (índice único parcial)', async () => {
    await wallet(ID(50));
    await tx(ID(51), ID(50), { status: 'PROCESSED' }); // a BET
    await tx(ID(52), ID(50), { kind: 'REFUND', ref: 'ext-x', refId: ID(51), status: 'PROCESSED' });
    // ROLLBACK da mesma BET, também PROCESSED: viola a unicidade
    await expect(
      tx(ID(53), ID(50), { kind: 'ROLLBACK', ref: 'ext-x', refId: ID(51), status: 'PROCESSED' }),
    ).rejects.toMatchObject({ code: UNIQUE });
    // mas uma tentativa REJECTED não conta
    await tx(ID(54), ID(50), { kind: 'ROLLBACK', ref: 'ext-x', refId: ID(51), status: 'REJECTED' });
  });

  test('transação em estado terminal é imutável e não pode ser apagada', async () => {
    await wallet(ID(60));
    await tx(ID(61), ID(60), { status: 'PROCESSED' });
    expect(await sqlState(client, `update wager_transactions set game_id = 'x' where id = $1`, [ID(61)])).toBe(OBJECT_STATE);
    expect(await sqlState(client, `update wager_transactions set status = 'REJECTED' where id = $1`, [ID(61)])).toBe(OBJECT_STATE);
    expect(await sqlState(client, `delete from wager_transactions where id = $1`, [ID(61)])).toBe(OBJECT_STATE);
    // não terminal pode evoluir
    await tx(ID(62), ID(60));
    expect(
      await sqlState(
        client,
        `update wager_transactions set status = 'PROCESSED', processed_at = $2, result_balance = 1.00 where id = $1`,
        [ID(62), T],
      ),
    ).toBe('ok');
  });

  test('status coerente: PROCESSED exige processed_at e saldo; REJECTED exige failure_code', async () => {
    await wallet(ID(70));
    await tx(ID(71), ID(70));
    expect(await sqlState(client, `update wager_transactions set status = 'PROCESSED' where id = $1`, [ID(71)])).toBe(CHECK);
    expect(await sqlState(client, `update wager_transactions set status = 'REJECTED' where id = $1`, [ID(71)])).toBe(CHECK);
  });

  test('ledger: aritmética do lançamento (CHECK)', async () => {
    await wallet(ID(80), 'ledger-math', '0.00');
    await tx(ID(81), ID(80), { status: 'PROCESSED' });
    await expect(ledger(ID(82), ID(80), ID(81), 'CREDIT', '10.00', '0.00', '9.00')).rejects.toMatchObject({ code: CHECK });
    await expect(ledger(ID(82), ID(80), ID(81), 'DEBIT', '10.00', '0.00', '-10.00')).rejects.toMatchObject({ code: CHECK });
    await expect(ledger(ID(82), ID(80), ID(81), 'BURN', '10.00', '0.00', '10.00')).rejects.toMatchObject({ code: CHECK });
    await expect(ledger(ID(82), ID(80), ID(81), 'CREDIT', '0.00', '0.00', '0.00')).rejects.toMatchObject({ code: CHECK });
  });

  test('ledger: imutável (UPDATE, DELETE e TRUNCATE proibidos)', async () => {
    await client.query('begin');
    await wallet(ID(90), 'ledger-immutable', '10.00');
    await tx(ID(91), ID(90), { status: 'PROCESSED' });
    await ledger(ID(92), ID(90), ID(91), 'CREDIT', '10.00', '0.00', '10.00');
    await client.query('commit');

    expect(await sqlState(client, `update wallet_ledger_entries set amount = 1 where id = $1`, [ID(92)])).toBe(OBJECT_STATE);
    expect(await sqlState(client, `delete from wallet_ledger_entries where id = $1`, [ID(92)])).toBe(OBJECT_STATE);
    expect(await sqlState(client, `truncate wallet_ledger_entries`)).toBe(OBJECT_STATE);
  });

  test('ledger: no máximo um lançamento por (transação, wallet)', async () => {
    await client.query('begin');
    await wallet(ID(100), 'ledger-once', '10.00');
    await tx(ID(101), ID(100), { status: 'PROCESSED' });
    await ledger(ID(102), ID(100), ID(101), 'CREDIT', '10.00', '0.00', '10.00');
    await expect(ledger(ID(103), ID(100), ID(101), 'CREDIT', '1.00', '10.00', '11.00')).rejects.toMatchObject({ code: UNIQUE });
    await client.query('rollback');
  });

  test('ledger: cadeia contínua (balance_before == balance_after anterior)', async () => {
    await client.query('begin');
    await wallet(ID(110), 'ledger-chain', '10.00');
    await tx(ID(111), ID(110), { status: 'PROCESSED' });
    await tx(ID(112), ID(110), { status: 'PROCESSED' });
    await ledger(ID(113), ID(110), ID(111), 'CREDIT', '10.00', '0.00', '10.00');
    // tenta pular o saldo: before=50 não bate com o último after=10
    await expect(ledger(ID(114), ID(110), ID(112), 'CREDIT', '10.00', '50.00', '60.00')).rejects.toMatchObject({ code: CHECK });
    await client.query('rollback');
  });

  test('saldo da wallet sem lançamento correspondente não passa no COMMIT', async () => {
    // altera o saldo sem ledger: a constraint trigger deferida derruba o commit
    await client.query('begin');
    await wallet(ID(120), 'no-ledger', '0.00');
    await client.query(`update wallets set balance = 5.00, version = 2 where id = $1`, [ID(120)]);
    await expect(client.query('commit')).rejects.toMatchObject({ code: CHECK });
    await client.query('rollback').catch(() => {});

    // com ledger consistente, o mesmo commit passa
    await client.query('begin');
    await wallet(ID(121), 'with-ledger', '5.00');
    await tx(ID(122), ID(121), { status: 'PROCESSED' });
    await ledger(ID(123), ID(121), ID(122), 'CREDIT', '5.00', '0.00', '5.00');
    await client.query('commit');
  });

  test('inbox: chave primária (consumer, messageId)', async () => {
    const insert = (consumer: string, id: string) =>
      sqlState(client, `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at) values ($1,$2,'h',$3)`, [consumer, id, T]);
    expect(await insert('c1', 'm1')).toBe('ok');
    expect(await insert('c1', 'm1')).toBe(UNIQUE);
    expect(await insert('c2', 'm1')).toBe('ok');
  });

  test('outbox: id do evento é único e o índice parcial só cobre pendentes', async () => {
    const insert = (id: string) =>
      sqlState(client, `insert into outbox_messages (id, aggregate_id, ordering_key, event_type, payload, occurred_at) values ($1,'a','a','E','{}',$2)`, [id, T]);
    expect(await insert(ID(200))).toBe('ok');
    expect(await insert(ID(200))).toBe(UNIQUE);
    const { rows } = await client.query(
      `select indexdef from pg_indexes where indexname = 'ix_outbox_pending'`,
    );
    expect(rows[0].indexdef).toContain('WHERE (published_at IS NULL)');
  });

  test('índices de apoio existem', async () => {
    const { rows } = await client.query(
      `select indexname from pg_indexes where tablename in ('wager_transactions','wallet_ledger_entries','outbox_messages')`,
    );
    const names = rows.map((r) => r.indexname);
    for (const expected of [
      'uq_wager_tx_one_reversal_per_reference',
      'ix_wager_tx_pending_due',
      'ix_wager_tx_pending_reference',
      'ix_ledger_wallet_seq',
      'ix_outbox_pending',
    ]) {
      expect(names).toContain(expected);
    }
  });
});

describe('migrations versionadas e reversíveis', () => {
  test('up -> down (tudo) -> up de novo, sem sobras', async () => {
    const fresh = await createTestDatabase({ migrate: false });
    try {
      const orm = await createOrm({ databaseUrl: fresh.url, poolMax: 2 });
      const tables = () =>
        withClient(fresh.url, async (c) => {
          const { rows } = await c.query(
            `select table_name from information_schema.tables where table_schema = 'public' and table_name <> 'mikro_orm_migrations' order by 1`,
          );
          return rows.map((r) => r.table_name as string);
        });
      try {
        const migrator = orm.getMigrator();
        await migrator.up();
        expect(await tables()).toEqual(['inbox_messages', 'outbox_messages', 'wager_transactions', 'wallet_ledger_entries', 'wallets']);
        expect((await migrator.getPendingMigrations()).length).toBe(0);

        await migrator.down({ to: 0 });
        expect(await tables()).toEqual([]);
        const leftovers = await withClient(fresh.url, async (c) => {
          const { rows } = await c.query(
            `select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`,
          );
          return rows.map((r) => r.proname);
        });
        expect(leftovers).toEqual([]);

        await migrator.up();
        expect((await tables()).length).toBe(5);
      } finally {
        await orm.close(true);
      }
    } finally {
      await fresh.drop();
    }
  });
});
