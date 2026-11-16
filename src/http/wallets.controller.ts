import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { CreateWallet } from '../application/create-wallet';
import { WalletQueries } from '../application/wallet-queries';
import { type AppLogger, LOGGER } from '../infrastructure/observability/logging';
import { correlationIdOf } from './correlation-id.middleware';
import { ProviderAuthGuard } from './provider-auth.guard';
import { createWalletBody, ledgerQuery, parse, uuidParam } from './request-schemas';

@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  private readonly logger: AppLogger;

  constructor(
    @Inject(CreateWallet) private readonly createWallet: CreateWallet,
    @Inject(WalletQueries) private readonly queries: WalletQueries,
    @Inject(LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ component: 'http' });
  }

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    const input = parse(createWalletBody, body);
    const wallet = await this.createWallet.execute({ ...input, correlationId: correlationIdOf(response) });
    this.logger.info({ walletId: wallet.id }, 'wallet created');
    return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance, version: wallet.version };
  }

  @Get(':walletId')
  get(@Param('walletId') walletId: string) {
    return this.queries.getWallet(parse(uuidParam, walletId, 'INVALID_PARAMETER'));
  }

  @Get(':walletId/ledger')
  ledger(@Param('walletId') walletId: string, @Query() query: unknown) {
    const { cursor, limit } = parse(ledgerQuery, query, 'INVALID_PARAMETER');
    return this.queries.getLedger(parse(uuidParam, walletId, 'INVALID_PARAMETER'), { cursor, limit });
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconcile(@Param('walletId') walletId: string) {
    return this.queries.reconcile(parse(uuidParam, walletId, 'INVALID_PARAMETER'));
  }
}
