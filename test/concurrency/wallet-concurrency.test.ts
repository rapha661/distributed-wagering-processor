import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { bet, createTestContext, expectConsistent, openWallet, sql, type TestContext } from '../integration/support/context';

// Paralelismo real: cada chamada abre a própria transação SQL numa conexão do pool,
// e todas disputam o mesmo lock de linha no Postgres ao mesmo tempo.

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
});

const debitsOf = async (walletId: string) =>
  (
    await sql<{ total: number }>(
      ctx,
      `select count(*)::int as total from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`,
      [walletId],
    )
  )[0]?.total;

describe('concorrência na mesma wallet', () => {
  it('a mesma aposta enviada 50 vezes em paralelo gera um único débito', async () => {
    const wallet = await openWallet(ctx, '1000.00');
    const command = bet(wallet, '25.00');

    const results = await Promise.all(Array.from({ length: 50 }, () => ctx.process.execute(command)));

    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(results.every((r) => r.status === 'PROCESSED' && r.balance?.amount === '975.00')).toBe(true);
    expect(await debitsOf(wallet.id)).toBe(1);
    expect((await ctx.queries.getWallet(wallet.id)).balance.amount).toBe('975.00');
    await expectConsistent(ctx, wallet.id);
  });

  it('cenário obrigatório: 100.00 e duas apostas de 80.00 simultâneas (20 rodadas)', async () => {
    for (let round = 0; round < 20; round++) {
      const wallet = await openWallet(ctx, '100.00');
      const commands = [bet(wallet, '80.00'), bet(wallet, '80.00')];

      const results = await Promise.all(commands.map((command) => ctx.process.execute(command)));

      expect(results.filter((r) => r.status === 'PROCESSED')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'REJECTED' && r.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(1);
      expect((await ctx.queries.getWallet(wallet.id)).balance.amount).toBe('20.00');
      expect(await debitsOf(wallet.id)).toBe(1);

      // nenhum retry duplica o débito
      const retries = await Promise.all(commands.flatMap((command) => [command, command]).map((c) => ctx.process.execute(c)));
      expect(retries.every((r) => r.idempotentReplay)).toBe(true);
      expect(await debitsOf(wallet.id)).toBe(1);
      await expectConsistent(ctx, wallet.id);
    }
  });

  it('muitas apostas distintas disputando o saldo nunca deixam negativo', async () => {
    const wallet = await openWallet(ctx, '10.00');
    const results = await Promise.all(Array.from({ length: 40 }, () => ctx.process.execute(bet(wallet, '1.00'))));

    expect(results.filter((r) => r.status === 'PROCESSED')).toHaveLength(10);
    expect(results.filter((r) => r.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(30);
    expect((await ctx.queries.getWallet(wallet.id)).balance.amount).toBe('0.00');
    await expectConsistent(ctx, wallet.id);
  });
});

describe('concorrência entre wallets', () => {
  it('wallets distintas são processadas em paralelo, cada uma consistente', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => openWallet(ctx, '10.00')));

    const started = performance.now();
    const results = await Promise.all(
      wallets.flatMap((wallet) => Array.from({ length: 15 }, () => ctx.process.execute(bet(wallet, '1.00')))),
    );
    const elapsed = performance.now() - started;

    expect(results.filter((r) => r.status === 'PROCESSED')).toHaveLength(100);
    expect(results.filter((r) => r.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(50);
    for (const wallet of wallets) {
      expect((await ctx.queries.getWallet(wallet.id)).balance.amount).toBe('0.00');
      expect(await debitsOf(wallet.id)).toBe(10);
      await expectConsistent(ctx, wallet.id);
    }
    expect(elapsed).toBeLessThan(30_000);
  });
});
