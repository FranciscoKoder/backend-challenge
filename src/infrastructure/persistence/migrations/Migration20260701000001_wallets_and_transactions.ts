import { Migration } from '@mikro-orm/migrations';

/**
 * wallets + wager_transactions.
 * Unicidade, não-negatividade e terminalidade são garantidas aqui, no schema.
 */
export class Migration20260701000001_wallets_and_transactions extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id text not null,
        currency char(3) not null,
        balance numeric(18,2) not null,
        version integer not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint ck_wallets_player_id check (length(player_id) between 1 and 128),
        constraint ck_wallets_currency check (currency ~ '^[A-Z]{3}$'),
        constraint ck_wallets_balance_non_negative check (balance >= 0),
        constraint ck_wallets_version_positive check (version >= 1),
        constraint uq_wallets_player_currency unique (player_id, currency)
      )
    `);

    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id text not null,
        external_transaction_id text not null,
        idempotency_key text not null,
        payload_hash text not null,
        wallet_id uuid not null references wallets (id),
        player_id text not null,
        round_id text not null,
        game_id text not null,
        kind text not null,
        amount numeric(18,2) not null,
        currency char(3) not null,
        reference_external_transaction_id text,
        reference_transaction_id uuid references wager_transactions (id),
        status text not null,
        failure_code text,
        result_balance numeric(18,2),
        pending_attempts integer not null default 0,
        next_attempt_at timestamptz,
        created_at timestamptz not null,
        processed_at timestamptz,
        updated_at timestamptz not null,

        constraint ck_wager_tx_ids check (
          length(provider_id) between 1 and 64
          and length(external_transaction_id) between 1 and 128
          and length(idempotency_key) between 1 and 255
        ),
        constraint ck_wager_tx_payload_hash check (payload_hash ~ '^[0-9a-f]{64}$'),
        constraint ck_wager_tx_kind check (kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        constraint ck_wager_tx_status check (
          status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')
        ),
        constraint ck_wager_tx_amount_positive check (amount > 0),
        constraint ck_wager_tx_currency check (currency ~ '^[A-Z]{3}$'),
        -- REFUND e ROLLBACK sempre carregam a referência do provedor
        constraint ck_wager_tx_reference_required check (
          kind not in ('REFUND','ROLLBACK') or reference_external_transaction_id is not null
        ),
        -- falha <=> estado de rejeição/falha
        constraint ck_wager_tx_failure_code check (
          (status in ('REJECTED','FAILED')) = (failure_code is not null)
        ),
        constraint ck_wager_tx_processed_at check ((status = 'PROCESSED') = (processed_at is not null)),
        constraint ck_wager_tx_processed_balance check (status <> 'PROCESSED' or result_balance is not null),
        constraint ck_wager_tx_pending_schedule check (
          status <> 'PENDING_REFERENCE' or next_attempt_at is not null
        ),
        constraint ck_wager_tx_pending_attempts check (pending_attempts >= 0),

        -- deduplicação persistente
        constraint uq_wager_tx_provider_external unique (provider_id, external_transaction_id),
        constraint uq_wager_tx_provider_idempotency unique (provider_id, idempotency_key)
      )
    `);

    // Uma referência só pode ser revertida uma vez (REFUND ou ROLLBACK), mesmo sob corrida.
    this.addSql(`
      create unique index uq_wager_tx_one_reversal_per_reference
        on wager_transactions (reference_transaction_id)
        where kind in ('REFUND','ROLLBACK') and status = 'PROCESSED'
    `);
    this.addSql(`
      create index ix_wager_tx_pending_due
        on wager_transactions (next_attempt_at)
        where status = 'PENDING_REFERENCE'
    `);
    this.addSql(`
      create index ix_wager_tx_pending_reference
        on wager_transactions (provider_id, reference_external_transaction_id)
        where status = 'PENDING_REFERENCE'
    `);
    this.addSql(`create index ix_wager_tx_wallet on wager_transactions (wallet_id, created_at)`);

    // Estados terminais e auditoria: nunca mudam nem somem.
    this.addSql(`
      create function forbid_wager_transaction_tampering() returns trigger
      language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'wager_transactions e auditavel: DELETE proibido' using errcode = '55000';
        end if;
        if old.status in ('PROCESSED','REJECTED','FAILED') then
          raise exception 'transacao % ja esta em estado terminal (%)', old.id, old.status
            using errcode = '55000';
        end if;
        return new;
      end
      $$
    `);
    this.addSql(`
      create trigger trg_wager_transactions_terminal
        before update or delete on wager_transactions
        for each row execute function forbid_wager_transaction_tampering()
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop trigger if exists trg_wager_transactions_terminal on wager_transactions`);
    this.addSql(`drop function if exists forbid_wager_transaction_tampering()`);
    this.addSql(`drop table if exists wager_transactions`);
    this.addSql(`drop table if exists wallets`);
  }
}
