import { Migration } from '@mikro-orm/migrations';

export class Migration20261116120000InitialSchema extends Migration {
  override name = 'Migration20261116120000_initial_schema';

  override up(): void {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id uuid not null,
        currency char(3) not null,
        balance numeric(20, 2) not null,
        version integer not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallets_player_currency_key unique (player_id, currency),
        constraint wallets_id_currency_key unique (id, currency),
        constraint wallets_currency_check check (currency ~ '^[A-Z]{3}$'),
        constraint wallets_balance_check check (balance >= 0),
        constraint wallets_version_check check (version >= 1)
      );
    `);

    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id varchar(128) not null,
        external_transaction_id varchar(255) not null,
        idempotency_key varchar(255) not null,
        payload_hash char(64) not null,
        wallet_id uuid not null references wallets (id),
        player_id uuid not null,
        round_id varchar(255) not null,
        game_id varchar(255) not null,
        kind varchar(16) not null,
        amount numeric(20, 2) not null,
        currency char(3) not null,
        reference_external_transaction_id varchar(255),
        reference_transaction_id uuid references wager_transactions (id),
        status varchar(32) not null,
        failure_code varchar(64),
        observed_balance numeric(20, 2),
        reference_attempts integer not null default 0,
        next_reference_attempt_at timestamptz,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        processed_at timestamptz,
        constraint wager_transactions_idempotency_key_key unique (idempotency_key),
        constraint wager_transactions_provider_external_key unique (provider_id, external_transaction_id),
        constraint wager_transactions_id_wallet_key unique (id, wallet_id),
        constraint wager_transactions_kind_check
          check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint wager_transactions_status_check
          check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint wager_transactions_currency_check check (currency ~ '^[A-Z]{3}$'),
        constraint wager_transactions_amount_check check (amount > 0 or (amount = 0 and kind = 'LOSS')),
        constraint wager_transactions_observed_balance_check check (observed_balance >= 0),
        constraint wager_transactions_reference_attempts_check check (reference_attempts >= 0),
        constraint wager_transactions_reference_required_check
          check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null),
        constraint wager_transactions_reference_resolved_check
          check (reference_transaction_id is null or status = 'PROCESSED'),
        constraint wager_transactions_reversal_resolved_check
          check (status <> 'PROCESSED' or kind not in ('REFUND', 'ROLLBACK') or reference_transaction_id is not null),
        constraint wager_transactions_failure_code_check
          check ((status in ('REJECTED', 'FAILED')) = (failure_code is not null)),
        constraint wager_transactions_processed_at_check
          check ((status = 'PROCESSED') = (processed_at is not null)),
        constraint wager_transactions_next_attempt_check
          check ((status = 'PENDING_REFERENCE') = (next_reference_attempt_at is not null))
      );
    `);

    // uma transação é revertida (REFUND ou ROLLBACK) no máximo uma vez
    this.addSql(`
      create unique index wager_transactions_single_reversal_idx
        on wager_transactions (reference_transaction_id)
        where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK');
    `);
    this.addSql(`
      create index wager_transactions_pending_reference_idx
        on wager_transactions (next_reference_attempt_at)
        where status = 'PENDING_REFERENCE';
    `);

    this.addSql(`
      create function wager_transactions_guard() returns trigger language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'wager transaction % cannot be deleted', old.id;
        end if;
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'wager transaction % is % and cannot change', old.id, old.status;
        end if;
        if (new.id, new.provider_id, new.external_transaction_id, new.idempotency_key, new.payload_hash,
            new.wallet_id, new.player_id, new.round_id, new.game_id, new.kind, new.amount, new.currency,
            new.reference_external_transaction_id, new.created_at)
           is distinct from
           (old.id, old.provider_id, old.external_transaction_id, old.idempotency_key, old.payload_hash,
            old.wallet_id, old.player_id, old.round_id, old.game_id, old.kind, old.amount, old.currency,
            old.reference_external_transaction_id, old.created_at) then
          raise exception 'business fields of wager transaction % are immutable', old.id;
        end if;
        return new;
      end;
      $$;
    `);
    this.addSql(`
      create trigger wager_transactions_guard
        before update or delete on wager_transactions
        for each row execute function wager_transactions_guard();
    `);

    this.addSql(`
      create table wallet_ledger_entries (
        id uuid primary key,
        wallet_id uuid not null,
        transaction_id uuid not null,
        wallet_version integer not null,
        direction varchar(6) not null,
        amount numeric(20, 2) not null,
        currency char(3) not null,
        balance_before numeric(20, 2) not null,
        balance_after numeric(20, 2) not null,
        created_at timestamptz not null,
        constraint wallet_ledger_entries_wallet_fk
          foreign key (wallet_id, currency) references wallets (id, currency),
        constraint wallet_ledger_entries_transaction_fk
          foreign key (transaction_id, wallet_id) references wager_transactions (id, wallet_id),
        constraint wallet_ledger_entries_transaction_key unique (wallet_id, transaction_id),
        constraint wallet_ledger_entries_version_key unique (wallet_id, wallet_version),
        constraint wallet_ledger_entries_direction_check check (direction in ('DEBIT', 'CREDIT')),
        constraint wallet_ledger_entries_amount_check check (amount > 0),
        constraint wallet_ledger_entries_balances_check check (balance_before >= 0 and balance_after >= 0),
        constraint wallet_ledger_entries_version_check check (wallet_version >= 1),
        constraint wallet_ledger_entries_balanced_check check (
          balance_after = case direction
            when 'CREDIT' then balance_before + amount
            else balance_before - amount
          end
        )
      );
    `);

    this.addSql(`
      create function wallet_ledger_entries_immutable() returns trigger language plpgsql as $$
      begin
        raise exception 'wallet ledger entries are append-only (% rejected)', tg_op;
      end;
      $$;
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_immutable
        before update or delete on wallet_ledger_entries
        for each row execute function wallet_ledger_entries_immutable();
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_no_truncate
        before truncate on wallet_ledger_entries
        for each statement execute function wallet_ledger_entries_immutable();
    `);

    this.addSql(`
      create table inbox_messages (
        consumer_name varchar(128) not null,
        message_id varchar(255) not null,
        payload_hash char(64) not null,
        received_at timestamptz not null,
        processed_at timestamptz,
        primary key (consumer_name, message_id)
      );
    `);

    this.addSql(`
      create table outbox_messages (
        id uuid primary key,
        aggregate_id uuid not null,
        event_type varchar(128) not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz not null,
        published_at timestamptz,
        constraint outbox_messages_attempts_check check (attempts >= 0)
      );
    `);
    this.addSql(`
      create index outbox_messages_pending_idx
        on outbox_messages (next_attempt_at)
        where published_at is null;
    `);
  }

  override down(): void {
    this.addSql('drop table if exists outbox_messages;');
    this.addSql('drop table if exists inbox_messages;');
    this.addSql('drop table if exists wallet_ledger_entries;');
    this.addSql('drop function if exists wallet_ledger_entries_immutable();');
    this.addSql('drop table if exists wager_transactions;');
    this.addSql('drop function if exists wager_transactions_guard();');
    this.addSql('drop table if exists wallets;');
  }
}
