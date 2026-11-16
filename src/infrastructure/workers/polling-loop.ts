export interface LoopLogger {
  error(fields: Record<string, unknown>, message: string): void;
}

/**
 * Executa `tick` em sequência enquanto houver trabalho; quando um tick não encontra nada
 * (ou falha), espera `idleMs`. `stop()` interrompe a espera e aguarda o tick em andamento.
 */
export class PollingLoop {
  private running = false;
  private current: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly name: string,
    private readonly tick: () => Promise<boolean>,
    private readonly idleMs: number,
    private readonly logger: LoopLogger,
  ) {}

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.current = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.current;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      let didWork = false;
      try {
        didWork = await this.tick();
      } catch (error) {
        this.logger.error({ worker: this.name, err: error }, 'background worker failed');
      }
      if (!didWork && this.running) {
        await this.sleep(this.idleMs);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      this.wake = done;
      function done() {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}
