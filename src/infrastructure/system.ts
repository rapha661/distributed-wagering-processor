import type { Clock, IdGenerator } from '../application/ports';

export const systemClock: Clock = {
  now: () => new Date(),
};

/** UUIDv7: ordenável no tempo, o que mantém os índices por id próximos da ordem de inserção. */
export const uuidV7Generator: IdGenerator = {
  next: () => Bun.randomUUIDv7(),
};
