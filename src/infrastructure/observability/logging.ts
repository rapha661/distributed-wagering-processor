import { AsyncLocalStorage } from 'node:async_hooks';
import type { LoggerService } from '@nestjs/common';
import pino, { type DestinationStream, type Logger } from 'pino';

export type AppLogger = Logger;
export const LOGGER = Symbol('LOGGER');

/** Campos de correlação anexados a todo log emitido dentro de `withLogContext`. */
export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const context = new AsyncLocalStorage<LogContext>();

export function withLogContext<T>(fields: LogContext, work: () => T): T {
  return context.run({ ...context.getStore(), ...fields }, work);
}

/**
 * Logs JSON, um por linha. Valores e saldos não são logados; a redação é só uma segunda
 * barreira caso algum payload financeiro escape para um log.
 */
export function createLogger(level: string, destination?: DestinationStream): AppLogger {
  return pino(
    {
      level,
      base: { pid: process.pid },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      mixin: () => ({ ...context.getStore() }),
      redact: { paths: ['money', 'balance', 'initialBalance', '*.money', '*.balance'], censor: '[redacted]' },
    },
    destination,
  );
}

/** Logs do próprio Nest (bootstrap, rotas, shutdown) no mesmo formato JSON. */
export class NestLogger implements LoggerService {
  constructor(private readonly logger: AppLogger) {}

  log(message: unknown, ...params: unknown[]): void {
    this.write('info', message, params);
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.write('warn', message, params);
  }

  error(message: unknown, ...params: unknown[]): void {
    this.write('error', message, params);
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.write('debug', message, params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.write('trace', message, params);
  }

  private write(level: 'info' | 'warn' | 'error' | 'debug' | 'trace', message: unknown, params: unknown[]): void {
    // o Nest passa o contexto (nome da classe) como último parâmetro, e o stack antes dele
    const last = params.at(-1);
    const fields: Record<string, unknown> = typeof last === 'string' ? { context: last } : {};
    if (level === 'error' && params.length > 1 && typeof params[0] === 'string') {
      fields.stack = params[0];
    }
    if (message instanceof Error) {
      this.logger[level]({ ...fields, err: message }, message.message);
    } else if (typeof message === 'object' && message !== null) {
      this.logger[level]({ ...fields, ...message });
    } else {
      this.logger[level](fields, String(message));
    }
  }
}
