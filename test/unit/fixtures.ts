import { Money } from '../../src/domain/money/money';
import { Wallet } from '../../src/domain/wallet/wallet';

export const NOW = new Date('2026-07-29T15:00:00.000Z');
export const PLAYER_ID = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
export const WALLET_ID = '0192f291-27dd-7d3f-8071-5f8685deef37';

export const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
export const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

export const newId = () => crypto.randomUUID();

export function aWallet(balance = '100.00', overrides: { id?: string; playerId?: string } = {}): Wallet {
  return Wallet.rehydrate({
    id: overrides.id ?? WALLET_ID,
    playerId: overrides.playerId ?? PLAYER_ID,
    currency: 'BRL',
    balance: brl(balance),
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
}
