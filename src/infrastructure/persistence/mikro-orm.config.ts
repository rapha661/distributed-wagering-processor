import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import type { AppConfig } from '../../config';
import { ENTITIES } from './entities';
import { Migration20261116120000InitialSchema } from './migrations/Migration20261116120000InitialSchema';

export function createOrmConfig(config: Pick<AppConfig, 'DATABASE_URL' | 'DATABASE_POOL_MAX'>) {
  return defineConfig({
    clientUrl: config.DATABASE_URL,
    entities: ENTITIES,
    pool: { min: 0, max: config.DATABASE_POOL_MAX },
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
