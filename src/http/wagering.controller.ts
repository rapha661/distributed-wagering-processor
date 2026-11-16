import { Body, Controller, Get, Headers, Inject, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { InvalidRequestError } from '../application/errors';
import { ProcessWagerTransaction, type WagerResult } from '../application/process-wager-transaction';
import { WalletQueries } from '../application/wallet-queries';
import { WagerTransactionStatus } from '../domain/wagering/wager-types';
import { type AppLogger, LOGGER } from '../infrastructure/observability/logging';
import { Metrics } from '../infrastructure/observability/metrics';
import { correlationIdOf } from './correlation-id.middleware';
import { ProviderAuthGuard } from './provider-auth.guard';
import { idempotencyKeyHeader, parse, submitWagerBody, textParam, uuidParam } from './request-schemas';

/**
 * O status HTTP de uma submissão vem do status da transação, e um replay devolve o mesmo
 * status e corpo do original: 201 aplicada · 202 aguardando referência · 422 rejeitada por regra.
 */
const STATUS_CODE: Record<WagerTransactionStatus, number> = {
  [WagerTransactionStatus.Processed]: 201,
  [WagerTransactionStatus.Pending]: 202,
  [WagerTransactionStatus.PendingReference]: 202,
  [WagerTransactionStatus.Rejected]: 422,
  [WagerTransactionStatus.Failed]: 500,
};

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  private readonly logger: AppLogger;

  constructor(
    @Inject(ProcessWagerTransaction) private readonly processWager: ProcessWagerTransaction,
    @Inject(WalletQueries) private readonly queries: WalletQueries,
    @Inject(Metrics) private readonly metrics: Metrics,
    @Inject(LOGGER) logger: AppLogger,
  ) {
    this.logger = logger.child({ component: 'http' });
  }

  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (idempotencyKey === undefined) {
      throw new InvalidRequestError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required');
    }
    const request = parse(submitWagerBody, body);
    const startedAt = performance.now();
    const result = await this.processWager.execute({
      idempotencyKey: parse(idempotencyKeyHeader, idempotencyKey, 'INVALID_IDEMPOTENCY_KEY'),
      request,
      correlationId: correlationIdOf(response),
    });
    this.metrics.recordSettlement('http', result, (performance.now() - startedAt) / 1_000);
    this.logger.info(
      {
        transactionId: result.transactionId,
        walletId: request.walletId,
        providerId: request.providerId,
        kind: request.kind,
        status: result.status,
        failureCode: result.failureCode ?? undefined,
        idempotentReplay: result.idempotentReplay,
      },
      'wager transaction submitted',
    );
    response.status(STATUS_CODE[result.status]);
    return toResponse(result);
  }

  @Get('wagering/transactions/:transactionId')
  get(@Param('transactionId') transactionId: string) {
    return this.queries.getTransaction(parse(uuidParam, transactionId, 'INVALID_PARAMETER'));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  getByExternalId(@Param('providerId') providerId: string, @Param('externalTransactionId') externalTransactionId: string) {
    return this.queries.getTransactionByExternalId(
      parse(textParam, providerId, 'INVALID_PARAMETER'),
      parse(textParam, externalTransactionId, 'INVALID_PARAMETER'),
    );
  }
}

function toResponse(result: WagerResult) {
  return {
    transactionId: result.transactionId,
    status: result.status,
    balance: result.balance,
    ...(result.failureCode && { failureCode: result.failureCode }),
    idempotentReplay: result.idempotentReplay,
  };
}
