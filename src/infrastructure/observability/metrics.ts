import { Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';
import type { WagerResult } from '../../application/process-wager-transaction';

export type SettlementSource = 'http' | 'sqs' | 'pending_reference';

/** Leituras do estado compartilhado (banco e fila), feitas a cada scrape. */
export interface BacklogProbe {
  outboxPending(): Promise<number>;
  outboxLagSeconds(): Promise<number>;
  pendingReferences(): Promise<number>;
  deadLetterMessages(): Promise<number>;
}

/**
 * Métricas Prometheus da instância. Contadores e latência são por processo (o Prometheus soma
 * as instâncias); os gauges de backlog leem o estado compartilhado e valem para o sistema todo.
 */
export class Metrics {
  readonly registry = new Registry();

  readonly transactions = new Counter({
    name: 'wager_transactions_total',
    help: 'Transações liquidadas, por status e origem (replays não entram)',
    labelNames: ['status', 'source'],
    registers: [this.registry],
  });

  readonly duplicates = new Counter({
    name: 'wager_duplicates_total',
    help: 'Submissões repetidas respondidas com replay (idempotency key ou inbox)',
    labelNames: ['source'],
    registers: [this.registry],
  });

  readonly processingSeconds = new Histogram({
    name: 'wager_processing_duration_seconds',
    help: 'Latência do processamento de uma transação, do recebimento ao commit',
    labelNames: ['source'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  readonly retries = new Counter({
    name: 'wager_retries_total',
    help: 'Novas tentativas agendadas, por operação e motivo',
    labelNames: ['operation', 'reason'],
    registers: [this.registry],
  });

  readonly deadLettered = new Counter({
    name: 'wager_messages_dead_lettered_total',
    help: 'Mensagens enviadas para a DLQ, por código de erro',
    labelNames: ['code'],
    registers: [this.registry],
  });

  readonly lockConflicts = new Counter({
    name: 'wallet_lock_conflicts_total',
    help: 'Esperas pelo lock da wallet que estouraram o lock_timeout ou terminaram em deadlock',
    registers: [this.registry],
  });

  readonly reconciliationMismatches = new Counter({
    name: 'wallet_reconciliation_mismatches_total',
    help: 'Reconciliações em que o saldo da wallet divergiu do ledger',
    registers: [this.registry],
  });

  constructor(probe?: BacklogProbe) {
    if (probe) {
      this.gauge('outbox_pending_messages', 'Eventos na outbox ainda não publicados', () => probe.outboxPending());
      this.gauge('outbox_lag_seconds', 'Idade do evento mais antigo ainda não publicado', () => probe.outboxLagSeconds());
      this.gauge('wager_pending_reference_transactions', 'Transações aguardando a referência', () => probe.pendingReferences());
      this.gauge('wager_dead_letter_queue_messages', 'Mensagens paradas na DLQ', () => probe.deadLetterMessages());
    }
  }

  recordSettlement(source: SettlementSource, result: WagerResult, seconds: number): void {
    this.processingSeconds.observe({ source }, seconds);
    if (result.idempotentReplay) {
      this.duplicates.inc({ source });
    } else {
      this.transactions.inc({ status: result.status, source });
    }
  }

  private gauge(name: string, help: string, read: () => Promise<number>): void {
    new Gauge({
      name,
      help,
      registers: [this.registry],
      async collect() {
        try {
          this.set(await read());
        } catch {
          // dependência fora do ar: o valor fica indefinido em vez de mentir
          this.set(Number.NaN);
        }
      },
    });
  }
}
