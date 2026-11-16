import type { Clock } from '../../../src/application/ports';

/** Relógio controlado pelo teste, para tornar backoff e vencimentos determinísticos. */
export class TestClock implements Clock {
  private current: number;

  constructor(start: Date = new Date()) {
    this.current = start.getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current += ms;
  }
}
