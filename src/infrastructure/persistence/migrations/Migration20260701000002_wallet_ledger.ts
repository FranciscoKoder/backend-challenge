import { Migration } from '@mikro-orm/migrations';

/**
 * Ledger imutável + garantias de consistência entre saldo materializado e ledger:
 *  - UPDATE/DELETE/TRUNCATE proibidos (trigger);
 *  - cadeia contínua: balance_before == balance_after do lançamento anterior da wallet;
 *  - constraint trigger deferida: ao COMMIT, wallets.balance == último balance_after.
 */
export class Migration20260701000002_wallet_ledger extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wallet_ledger_entries (
        seq bigint generated always as identity primary key,
        id uuid not null,
        wallet_id uuid not null references wallets (id),
        transaction_id uuid not null references wager_transactions (id),
        direction text not null,
        amount numeric(18,2) not null,
        currency char(3) not null,
        balance_before numeric(18,2) not null,
        balance_after numeric(18,2) not null,
        created_at timestamptz not null,
        constraint uq_ledger_id unique (id),
        -- no máximo um lançamento por transação e por wallet
        constraint uq_ledger_transaction_wallet unique (transaction_id, wallet_id),
        constraint ck_ledger_direction check (direction in ('DEBIT','CREDIT')),
        constraint ck_ledger_amount_positive check (amount > 0),
        constraint ck_ledger_balances_non_negative check (balance_before >= 0 and balance_after >= 0),
        constraint ck_ledger_arithmetic check (
          balance_after = case direction
            when 'CREDIT' then balance_before + amount
            else balance_before - amount
          end
        )
      )
    `);
    this.addSql(`create index ix_ledger_wallet_seq on wallet_ledger_entries (wallet_id, seq)`);

    this.addSql(`
      create function forbid_ledger_mutation() returns trigger
      language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries e imutavel: % proibido', tg_op using errcode = '55000';
      end
      $$
    `);
    this.addSql(`
      create trigger trg_ledger_immutable
        before update or delete on wallet_ledger_entries
        for each row execute function forbid_ledger_mutation()
    `);
    this.addSql(`
      create trigger trg_ledger_no_truncate
        before truncate on wallet_ledger_entries
        for each statement execute function forbid_ledger_mutation()
    `);

    this.addSql(`
      create function check_ledger_chain() returns trigger
      language plpgsql as $$
      declare
        last_after numeric(18,2);
      begin
        select balance_after into last_after
          from wallet_ledger_entries
         where wallet_id = new.wallet_id
         order by seq desc
         limit 1;
        if coalesce(last_after, 0) <> new.balance_before then
          raise exception 'cadeia do ledger quebrada na wallet %: esperado balance_before=%, recebido=%',
            new.wallet_id, coalesce(last_after, 0), new.balance_before using errcode = '23514';
        end if;
        return new;
      end
      $$
    `);
    this.addSql(`
      create trigger trg_ledger_chain
        before insert on wallet_ledger_entries
        for each row execute function check_ledger_chain()
    `);

    this.addSql(`
      create function check_wallet_matches_ledger() returns trigger
      language plpgsql as $$
      declare
        last_after numeric(18,2);
      begin
        select balance_after into last_after
          from wallet_ledger_entries
         where wallet_id = new.id
         order by seq desc
         limit 1;
        if coalesce(last_after, 0) <> new.balance then
          raise exception 'saldo da wallet % (%) diverge do ledger (%)',
            new.id, new.balance, coalesce(last_after, 0) using errcode = '23514';
        end if;
        return null;
      end
      $$
    `);
    this.addSql(`
      create constraint trigger trg_wallet_matches_ledger
        after insert or update of balance on wallets
        deferrable initially deferred
        for each row execute function check_wallet_matches_ledger()
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop trigger if exists trg_wallet_matches_ledger on wallets`);
    this.addSql(`drop function if exists check_wallet_matches_ledger()`);
    this.addSql(`drop trigger if exists trg_ledger_chain on wallet_ledger_entries`);
    this.addSql(`drop function if exists check_ledger_chain()`);
    this.addSql(`drop trigger if exists trg_ledger_no_truncate on wallet_ledger_entries`);
    this.addSql(`drop trigger if exists trg_ledger_immutable on wallet_ledger_entries`);
    this.addSql(`drop function if exists forbid_ledger_mutation()`);
    this.addSql(`drop table if exists wallet_ledger_entries`);
  }
}
