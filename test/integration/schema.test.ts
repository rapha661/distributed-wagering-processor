import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { connectTestDatabase } from './support/database';
import { insertLedgerEntry, insertTransaction, insertWallet } from './support/rows';

let orm: MikroORM;
const db = () => orm.em.getConnection();

const UNIQUE = '23505';
const CHECK = '23514';
const FOREIGN_KEY = '23503';
const RAISED = 'P0001';

/** Espera que o Postgres recuse a operação com o SQLSTATE e a constraint (ou mensagem) indicados. */
async function expectViolation(operation: Promise<unknown>, sqlState: string, constraint: string | RegExp): Promise<void> {
  const error = (await operation.then(
    () => undefined,
    (reason: unknown) => reason,
  )) as { code?: string; constraint?: string; message?: string } | undefined;
  expect(error).toBeDefined();
  expect(error?.code).toBe(sqlState);
  if (typeof constraint === 'string') {
    expect(error?.constraint).toBe(constraint);
  } else {
    expect(error?.message).toMatch(constraint);
  }
}

beforeAll(async () => {
  // banco próprio: este arquivo derruba e recria o schema
  orm = await connectTestDatabase('wagering_test_schema');
});

afterAll(async () => {
  await orm.close();
});

describe('migrations', () => {
  it('são reversíveis: down remove o schema e up recria', async () => {
    const tables = async () =>
      (
        await db().execute<{ table_name: string }[]>(
          `select table_name from information_schema.tables
           where table_schema = 'public' and table_name <> 'schema_migrations' order by table_name`,
        )
      ).map((row) => row.table_name);

    expect(await tables()).toEqual([
      'inbox_messages',
      'outbox_messages',
      'wager_transactions',
      'wallet_ledger_entries',
      'wallets',
    ]);

    await orm.migrator.down();
    expect(await tables()).toEqual([]);
    expect(await orm.migrator.getPending()).toHaveLength(1);

    await orm.migrator.up();
    expect(await tables()).toHaveLength(5);
  });
});

describe('wallets', () => {
  it('no máximo uma wallet por jogador e moeda', async () => {
    const wallet = await insertWallet(db());
    await insertWallet(db(), { playerId: wallet.playerId, currency: 'USD' });
    await expectViolation(
      insertWallet(db(), { playerId: wallet.playerId }),
      UNIQUE,
      'wallets_player_currency_key',
    );
  });

  it('saldo nunca negativo, nem por update', async () => {
    await expectViolation(insertWallet(db(), { balance: '-0.01' }), CHECK, 'wallets_balance_check');
    const wallet = await insertWallet(db(), { balance: '10.00' });
    await expectViolation(
      db().execute('update wallets set balance = balance - 10.01 where id = ?', [wallet.id]),
      CHECK,
      'wallets_balance_check',
    );
  });

  it('versão começa em 1 e moeda segue ISO-4217', async () => {
    await expectViolation(insertWallet(db(), { version: 0 }), CHECK, 'wallets_version_check');
    await expectViolation(insertWallet(db(), { currency: 'brl' }), CHECK, 'wallets_currency_check');
  });

  it('guarda valor exato com 2 casas', async () => {
    const wallet = await insertWallet(db(), { balance: '999999999999999999.99' });
    const [row] = await db().execute<{ balance: string }[]>('select balance::text from wallets where id = ?', [wallet.id]);
    expect(row?.balance).toBe('999999999999999999.99');
  });
});

describe('wager_transactions', () => {
  it('idempotency key é única', async () => {
    const wallet = await insertWallet(db());
    const bet = await insertTransaction(db(), wallet);
    await expectViolation(
      insertTransaction(db(), wallet, { idempotencyKey: bet.idempotencyKey }),
      UNIQUE,
      'wager_transactions_idempotency_key_key',
    );
  });

  it('(provider, externalTransactionId) é único mesmo com outra key', async () => {
    const wallet = await insertWallet(db());
    const bet = await insertTransaction(db(), wallet);
    await expectViolation(
      insertTransaction(db(), wallet, { externalTransactionId: bet.externalTransactionId, idempotencyKey: 'outra-key' }),
      UNIQUE,
      'wager_transactions_provider_external_key',
    );
  });

  it('REFUND e ROLLBACK exigem referência', async () => {
    const wallet = await insertWallet(db());
    for (const kind of ['REFUND', 'ROLLBACK']) {
      await expectViolation(
        insertTransaction(db(), wallet, { kind, status: 'REJECTED', failureCode: 'X' }),
        CHECK,
        'wager_transactions_reference_required_check',
      );
    }
  });

  it('valor zero só em LOSS', async () => {
    const wallet = await insertWallet(db());
    await insertTransaction(db(), wallet, { kind: 'LOSS', amount: '0.00' });
    await expectViolation(
      insertTransaction(db(), wallet, { amount: '0.00' }),
      CHECK,
      'wager_transactions_amount_check',
    );
  });

  it('status e campos de resultado andam juntos', async () => {
    const wallet = await insertWallet(db());
    await expectViolation(
      insertTransaction(db(), wallet, { status: 'REJECTED' }),
      CHECK,
      'wager_transactions_failure_code_check',
    );
    await expectViolation(
      insertTransaction(db(), wallet, { status: 'PROCESSED', failureCode: 'INSUFFICIENT_FUNDS' }),
      CHECK,
      'wager_transactions_failure_code_check',
    );
    await expectViolation(
      insertTransaction(db(), wallet, { status: 'PROCESSED', processedAt: null }),
      CHECK,
      'wager_transactions_processed_at_check',
    );
    await expectViolation(
      insertTransaction(db(), wallet, { status: 'PENDING_REFERENCE', nextReferenceAttemptAt: null }),
      CHECK,
      'wager_transactions_next_attempt_check',
    );
    await expectViolation(
      insertTransaction(db(), wallet, { status: 'SETTLED' }),
      CHECK,
      'wager_transactions_status_check',
    );
  });

  it('reversão processada precisa da referência resolvida', async () => {
    const wallet = await insertWallet(db());
    await expectViolation(
      insertTransaction(db(), wallet, { kind: 'REFUND', referenceExternalTransactionId: 'bet-1' }),
      CHECK,
      'wager_transactions_reversal_resolved_check',
    );
  });

  it('uma transação é revertida uma única vez, por qualquer tipo', async () => {
    const wallet = await insertWallet(db());
    const bet = await insertTransaction(db(), wallet);
    const reversal = {
      referenceExternalTransactionId: bet.externalTransactionId,
      referenceTransactionId: bet.id,
    };

    await insertTransaction(db(), wallet, { kind: 'REFUND', ...reversal });
    await expectViolation(
      insertTransaction(db(), wallet, { kind: 'REFUND', ...reversal }),
      UNIQUE,
      'wager_transactions_single_reversal_idx',
    );
    await expectViolation(
      insertTransaction(db(), wallet, { kind: 'ROLLBACK', ...reversal }),
      UNIQUE,
      'wager_transactions_single_reversal_idx',
    );
    // tentativas rejeitadas continuam auditáveis
    await insertTransaction(db(), wallet, {
      kind: 'REFUND',
      referenceExternalTransactionId: bet.externalTransactionId,
      status: 'REJECTED',
      failureCode: 'REFERENCE_ALREADY_REVERSED',
    });
  });

  it('PENDING_REFERENCE pode ser resolvida depois', async () => {
    const wallet = await insertWallet(db());
    const refund = await insertTransaction(db(), wallet, {
      kind: 'REFUND',
      referenceExternalTransactionId: 'bet-que-chega-depois',
      status: 'PENDING_REFERENCE',
    });
    const bet = await insertTransaction(db(), wallet, { externalTransactionId: 'bet-que-chega-depois' });

    await db().execute(
      `update wager_transactions
       set status = 'PROCESSED', reference_transaction_id = ?, processed_at = now(),
           next_reference_attempt_at = null, reference_attempts = 1, updated_at = now()
       where id = ?`,
      [bet.id, refund.id],
    );
    const [row] = await db().execute<{ status: string }[]>('select status from wager_transactions where id = ?', [refund.id]);
    expect(row?.status).toBe('PROCESSED');
  });

  it('estado terminal não muda', async () => {
    const wallet = await insertWallet(db());
    for (const status of ['PROCESSED', 'REJECTED', 'FAILED']) {
      const tx = await insertTransaction(db(), wallet, {
        status,
        failureCode: status === 'PROCESSED' ? null : 'X',
      });
      await expectViolation(
        db().execute(`update wager_transactions set updated_at = now() where id = ?`, [tx.id]),
        RAISED,
        /cannot change/,
      );
    }
  });

  it('campos de negócio são imutáveis mesmo antes do estado terminal', async () => {
    const wallet = await insertWallet(db());
    const refund = await insertTransaction(db(), wallet, {
      kind: 'REFUND',
      referenceExternalTransactionId: 'bet-x',
      status: 'PENDING_REFERENCE',
    });
    await expectViolation(
      db().execute(`update wager_transactions set amount = 99.00 where id = ?`, [refund.id]),
      RAISED,
      /are immutable/,
    );
  });

  it('não pode ser apagada', async () => {
    const wallet = await insertWallet(db());
    const tx = await insertTransaction(db(), wallet, { status: 'PENDING_REFERENCE', kind: 'REFUND', referenceExternalTransactionId: 'b' });
    await expectViolation(
      db().execute('delete from wager_transactions where id = ?', [tx.id]),
      RAISED,
      /cannot be deleted/,
    );
  });
});

describe('wallet_ledger_entries', () => {
  it('o lançamento precisa fechar a conta', async () => {
    const wallet = await insertWallet(db());
    const bet = await insertTransaction(db(), wallet);
    await expectViolation(
      insertLedgerEntry(db(), bet, { balanceAfter: '91.00' }),
      CHECK,
      'wallet_ledger_entries_balanced_check',
    );
    await expectViolation(
      insertLedgerEntry(db(), bet, { direction: 'CREDIT' }),
      CHECK,
      'wallet_ledger_entries_balanced_check',
    );
  });

  it('nunca registra saldo negativo nem valor zero', async () => {
    const wallet = await insertWallet(db());
    const bet = await insertTransaction(db(), wallet);
    await expectViolation(
      insertLedgerEntry(db(), bet, { balanceBefore: '5.00', balanceAfter: '-5.00' }),
      CHECK,
      'wallet_ledger_entries_balances_check',
    );
    await expectViolation(
      insertLedgerEntry(db(), bet, { amount: '0.00', balanceAfter: '100.00' }),
      CHECK,
      'wallet_ledger_entries_amount_check',
    );
  });

  it('no máximo um lançamento por transação na wallet', async () => {
    const wallet = await insertWallet(db());
    const bet = await insertTransaction(db(), wallet);
    await insertLedgerEntry(db(), bet);
    await expectViolation(
      insertLedgerEntry(db(), bet, { walletVersion: 3, balanceBefore: '90.00', balanceAfter: '80.00' }),
      UNIQUE,
      'wallet_ledger_entries_transaction_key',
    );
  });

  it('cada versão da wallet aparece uma vez: dois lançamentos sobre o mesmo saldo não passam', async () => {
    const wallet = await insertWallet(db());
    const first = await insertTransaction(db(), wallet);
    const second = await insertTransaction(db(), wallet);
    await insertLedgerEntry(db(), first, { walletVersion: 2 });
    await expectViolation(
      insertLedgerEntry(db(), second, { walletVersion: 2 }),
      UNIQUE,
      'wallet_ledger_entries_version_key',
    );
  });

  it('moeda e wallet do lançamento batem com a wallet e a transação', async () => {
    const wallet = await insertWallet(db());
    const other = await insertWallet(db());
    const bet = await insertTransaction(db(), wallet);
    await expectViolation(
      insertLedgerEntry(db(), bet, { currency: 'USD' }),
      FOREIGN_KEY,
      'wallet_ledger_entries_wallet_fk',
    );
    await expectViolation(
      insertLedgerEntry(db(), bet, { walletId: other.id }),
      FOREIGN_KEY,
      'wallet_ledger_entries_transaction_fk',
    );
  });

  it('é append-only: update, delete e truncate falham', async () => {
    const wallet = await insertWallet(db());
    const bet = await insertTransaction(db(), wallet);
    const entry = await insertLedgerEntry(db(), bet);

    await expectViolation(
      db().execute('update wallet_ledger_entries set amount = amount where id = ?', [entry.id]),
      RAISED,
      /append-only \(UPDATE/,
    );
    await expectViolation(
      db().execute('delete from wallet_ledger_entries where id = ?', [entry.id]),
      RAISED,
      /append-only \(DELETE/,
    );
    await expectViolation(db().execute('truncate wallet_ledger_entries'), RAISED, /append-only \(TRUNCATE/);

    const [row] = await db().execute<{ total: string }[]>(
      'select count(*)::text as total from wallet_ledger_entries where id = ?',
      [entry.id],
    );
    expect(row?.total).toBe('1');
  });
});

describe('inbox_messages', () => {
  it('(consumerName, messageId) é único', async () => {
    const insert = (consumer: string, messageId: string) =>
      db().execute(
        `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at) values (?, ?, ?, now())`,
        [consumer, messageId, 'b'.repeat(64)],
      );
    const messageId = `msg-${crypto.randomUUID()}`;
    await insert('wager-consumer', messageId);
    await insert('outro-consumer', messageId);
    await expectViolation(insert('wager-consumer', messageId), UNIQUE, 'inbox_messages_pkey');
  });
});
