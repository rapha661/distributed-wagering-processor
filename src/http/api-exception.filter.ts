import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Inject } from '@nestjs/common';
import type { Response } from 'express';
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  InvalidRequestError,
  TransactionNotFoundError,
  TransientFailureError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../application/errors';
import { InvalidMoneyError } from '../domain/money/money';
import { DomainError } from '../domain/shared/errors';
import { InvalidWagerTransactionError } from '../domain/wagering/wager-transaction';
import { type AppLogger, LOGGER } from '../infrastructure/observability/logging';
import { RequestValidationError } from './request-schemas';

export interface ErrorBody {
  code: string;
  message: string;
  details?: { path: string; message: string }[];
}

interface HttpError {
  status: number;
  body: ErrorBody;
  headers?: Record<string, string>;
}

/**
 * Mapeamento único de erro para HTTP, usado por todos os endpoints:
 * 400 payload inválido · 404 não encontrado · 409 conflito (idempotência/duplicidade)
 * 503 falha transitória (pode repetir) · 500 erro inesperado.
 * Rejeição por regra de negócio não é exceção: vira 422 no corpo da transação.
 */
export function toHttpError(error: unknown): HttpError {
  const body = (code: string, message: string): ErrorBody => ({ code, message });

  if (error instanceof RequestValidationError) {
    return { status: 400, body: { ...body(error.code, error.message), details: error.details } };
  }
  if (error instanceof InvalidMoneyError || error instanceof InvalidWagerTransactionError || error instanceof InvalidRequestError) {
    return { status: 400, body: body(error.code, error.message) };
  }
  if (error instanceof WalletNotFoundError || error instanceof TransactionNotFoundError) {
    return { status: 404, body: body(error.code, error.message) };
  }
  if (
    error instanceof WalletAlreadyExistsError ||
    error instanceof IdempotencyConflictError ||
    error instanceof ExternalTransactionConflictError
  ) {
    return { status: 409, body: body(error.code, error.message) };
  }
  if (error instanceof TransientFailureError) {
    return { status: 503, body: body(error.code, error.message), headers: { 'Retry-After': '1' } };
  }
  if (error instanceof DomainError) {
    return { status: 422, body: body(error.code, error.message) };
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    const code = status === 404 ? 'NOT_FOUND' : status === 400 ? 'INVALID_PAYLOAD' : 'HTTP_ERROR';
    return { status, body: body(code, error.message) };
  }
  return { status: 500, body: body('INTERNAL_ERROR', 'unexpected error') };
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger: AppLogger;

  constructor(@Inject(LOGGER) logger: AppLogger) {
    this.logger = logger.child({ component: 'http' });
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, body, headers } = toHttpError(exception);
    if (status === 503) {
      this.logger.warn({ status, code: body.code }, 'transient failure');
    } else if (status >= 500) {
      this.logger.error({ status, code: body.code, err: exception }, 'unexpected error');
    }
    for (const [name, value] of Object.entries(headers ?? {})) {
      response.setHeader(name, value);
    }
    response.status(status).json(body);
  }
}
