/** Violação de regra de negócio. Tem um código estável, legível por máquina. */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Transição de estado inválida: erro de programação, não caminho de negócio. */
export class InvalidStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
