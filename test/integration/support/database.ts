import { MikroORM } from '@mikro-orm/postgresql';
import { createOrmConfig } from '../../../src/infrastructure/persistence/mikro-orm.config';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5432/wagering';

/** Os testes usam um banco próprio, nunca o de desenvolvimento. */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? ADMIN_URL.replace(/\/[^/]+$/, '/wagering_test');

async function ensureTestDatabase(): Promise<void> {
  const name = new URL(TEST_DATABASE_URL).pathname.slice(1);
  const admin = await MikroORM.init(createOrmConfig({ DATABASE_URL: ADMIN_URL, DATABASE_POOL_MAX: 1 }));
  try {
    const connection = admin.em.getConnection();
    const rows = await connection.execute<{ found: boolean }[]>(
      'select exists (select 1 from pg_database where datname = ?) as found',
      [name],
    );
    if (!rows[0]?.found) {
      await connection.execute(`create database "${name}"`);
    }
  } finally {
    await admin.close();
  }
}

export async function connectTestDatabase(): Promise<MikroORM> {
  await ensureTestDatabase();
  const orm = await MikroORM.init(createOrmConfig({ DATABASE_URL: TEST_DATABASE_URL, DATABASE_POOL_MAX: 10 }));
  await orm.migrator.up();
  return orm;
}
