import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import type { AppConfig } from '../../config';
import { ENTITIES } from './entities';
import { Migration20261116120000InitialSchema } from './migrations/Migration20261116120000InitialSchema';

type OrmSettings = Pick<AppConfig, 'DATABASE_URL' | 'DATABASE_POOL_MAX'> &
  Partial<Pick<AppConfig, 'DATABASE_CONNECT_TIMEOUT_MS'>>;

export function createOrmConfig(config: OrmSettings) {
  return defineConfig({
    clientUrl: config.DATABASE_URL,
    entities: ENTITIES,
    pool: { min: 0, max: config.DATABASE_POOL_MAX },
    // sem isso o pg espera a conexão para sempre; com ele, banco fora do ar vira falha transitória
    driverOptions: { connectionTimeoutMillis: config.DATABASE_CONNECT_TIMEOUT_MS ?? 5_000 },
    extensions: [Migrator],
    migrations: {
      tableName: 'schema_migrations',
      migrationsList: [
        { name: 'Migration20261116120000_initial_schema', class: Migration20261116120000InitialSchema },
      ],
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
  });
}
