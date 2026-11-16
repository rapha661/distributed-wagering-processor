import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { withLogContext } from '../infrastructure/observability/logging';

export const CORRELATION_HEADER = 'x-correlation-id';
const VALID_CORRELATION_ID = /^[\w.:-]{1,128}$/;

/**
 * Usa o X-Correlation-Id recebido (se for válido) ou gera um, devolve no header da resposta e
 * o anexa a todo log emitido durante a requisição.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const received = request.header(CORRELATION_HEADER);
    const correlationId = received && VALID_CORRELATION_ID.test(received) ? received : Bun.randomUUIDv7();
    response.locals.correlationId = correlationId;
    response.setHeader(CORRELATION_HEADER, correlationId);
    withLogContext({ correlationId }, next);
  }
}

export function correlationIdOf(response: Response): string {
  return String(response.locals.correlationId);
}
