import { MikroORM } from '@mikro-orm/postgresql';
import { createOrmConfig } from '../../../src/infrastructure/persistence/mikro-orm.config';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5432/wagering';

/** Os testes usam um banco próprio, nunca o de desenvolvimento. */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? withDatabase(ADMIN_URL, 'wagering_test');

function withDatabase(url: string, database: string): string {
  return url.replace(/\/[^/]+$/, `/${database}`);
}

async function ensureDatabase(name: string): Promise<void> {
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

/**
 * Conecta num banco de teste já migrado. `database` permite isolar um arquivo de teste
 * (o de schema derruba e recria as tabelas, e não pode afetar os demais).
 */
export async function connectTestDatabase(database?: string): Promise<MikroORM> {
  const url = database ? withDatabase(TEST_DATABASE_URL, database) : TEST_DATABASE_URL;
  await ensureDatabase(new URL(url).pathname.slice(1));
  const orm = await MikroORM.init(createOrmConfig({ DATABASE_URL: url, DATABASE_POOL_MAX: 10 }));
  await orm.migrator.up();
  return orm;
}
