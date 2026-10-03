import { Migration } from '@mikro-orm/migrations';

export class Migration20260701000003_inbox_outbox extends Migration {
  override async up(): Promise<void> {
    // Deduplicação persistente de mensagens SQS por (consumidor, messageId).
    this.addSql(`
      create table inbox_messages (
        consumer_name text not null,
        message_id text not null,
        payload_hash text not null,
        received_at timestamptz not null,
        processed_at timestamptz,
        primary key (consumer_name, message_id)
      )
    `);

    this.addSql(`
      create table outbox_messages (
        seq bigint generated always as identity primary key,
        id uuid not null,
        aggregate_id text not null,
        -- wallet do evento (= MessageGroupId): eventos da mesma wallet saem em ordem
        ordering_key text not null,
        event_type text not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz,
        published_at timestamptz,
        last_error text,
        constraint uq_outbox_id unique (id),
        constraint ck_outbox_attempts check (attempts >= 0)
      )
    `);
    // Índice parcial: só o que ainda falta publicar. Lido com FOR UPDATE SKIP LOCKED.
    this.addSql(`create index ix_outbox_pending on outbox_messages (seq) where published_at is null`);
    this.addSql(
      `create index ix_outbox_pending_ordering on outbox_messages (ordering_key, seq) where published_at is null`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists outbox_messages`);
    this.addSql(`drop table if exists inbox_messages`);
  }
}
