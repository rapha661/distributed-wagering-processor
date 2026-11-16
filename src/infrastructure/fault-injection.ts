export type FaultPoint = 'crash-after-commit';

/**
 * Derruba o processo num ponto do fluxo, ligado por FAULT_INJECTION. Existe só para os testes
 * de recuperação com processos reais; fora deles a variável não é definida e nada acontece.
 */
export class FaultInjector {
  constructor(private readonly armed: FaultPoint | undefined) {}

  reach(point: FaultPoint): void {
    if (this.armed === point) {
      // como um kill -9: sem shutdown hooks, sem ack, sem flush
      process.exit(137);
    }
  }
}
