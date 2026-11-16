export class BackoffPolicy {
  constructor(
    readonly baseDelayMs: number,
    readonly maxDelayMs: number,
    readonly maxAttempts: number = Number.POSITIVE_INFINITY,
  ) {
    if (baseDelayMs <= 0 || maxDelayMs < baseDelayMs || maxAttempts < 1) {
      throw new RangeError('invalid backoff policy');
    }
  }

  /** Atraso antes da tentativa `attempt` (1, 2, 3...): base * 2^(attempt-1), limitado ao teto. */
  delayMs(attempt: number): number {
    return Math.min(this.baseDelayMs * 2 ** Math.max(0, attempt - 1), this.maxDelayMs);
  }

  nextAttemptAt(now: Date, attempt: number): Date {
    return new Date(now.getTime() + this.delayMs(attempt));
  }

  isExhausted(attempts: number): boolean {
    return attempts >= this.maxAttempts;
  }
}
