import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import type { AppConfig } from '../../config';

export function createOrmConfig(config: Pick<AppConfig, 'DATABASE_URL' | 'DATABASE_POOL_MAX'>) {
  return defineConfig({
    clientUrl: config.DATABASE_URL,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    pool: { min: 0, max: config.DATABASE_POOL_MAX },
    extensions: [Migrator],
    migrations: {
      tableName: 'schema_migrations',
      migrationsList: [],
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
  });
}
