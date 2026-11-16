import { describe, expect, it } from 'bun:test';
import { createLogger, withLogContext } from '../../src/infrastructure/observability/logging';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger('info', { write: (line: string) => void lines.push(JSON.parse(line)) });
  return { logger, lines };
}

describe('logs estruturados', () => {
  it('uma linha JSON por log, com nível legível e horário ISO', () => {
    const { logger, lines } = capture();
    logger.info({ transactionId: 'tx-1' }, 'settled');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'info', msg: 'settled', transactionId: 'tx-1' });
    expect(new Date(String(lines[0]?.time)).toISOString()).toBe(String(lines[0]?.time));
  });

  it('o contexto da requisição ou mensagem entra em todo log emitido dentro dela', async () => {
    const { logger, lines } = capture();

    await withLogContext({ correlationId: 'corr-1', messageId: 'msg-1' }, async () => {
      await Bun.sleep(1);
      withLogContext({ walletId: 'wallet-1', providerId: 'provider-a' }, () => logger.info({ transactionId: 'tx-1' }, 'inner'));
      logger.info('outer');
    });
    logger.info('outside');

    expect(lines[0]).toMatchObject({
      correlationId: 'corr-1',
      messageId: 'msg-1',
      walletId: 'wallet-1',
      providerId: 'provider-a',
      transactionId: 'tx-1',
    });
    expect(lines[1]).toMatchObject({ correlationId: 'corr-1', messageId: 'msg-1' });
    expect(lines[1]).not.toHaveProperty('walletId');
    expect(lines[2]).not.toHaveProperty('correlationId');
  });

  it('valores e saldos não vazam para o log', () => {
    const { logger, lines } = capture();
    logger.info({ money: { amount: '25.00', currency: 'BRL' }, request: { balance: { amount: '75.00' } } }, 'oops');

    expect(lines[0]).toMatchObject({ money: '[redacted]', request: { balance: '[redacted]' } });
    expect(JSON.stringify(lines[0])).not.toContain('25.00');
  });
});
