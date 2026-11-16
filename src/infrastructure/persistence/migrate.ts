import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../config';
import { createOrmConfig } from './mikro-orm.config';

const command = process.argv[2] ?? 'up';
const orm = await MikroORM.init(createOrmConfig(loadConfig()));

try {
  const migrator = orm.migrator;
  switch (command) {
    case 'up': {
      const applied = await migrator.up();
      console.log(applied.length ? `applied: ${applied.map((m) => m.name).join(', ')}` : 'nothing to apply');
      break;
    }
    case 'down': {
      const reverted = await migrator.down();
      console.log(reverted.length ? `reverted: ${reverted.map((m) => m.name).join(', ')}` : 'nothing to revert');
      break;
    }
    case 'status': {
      const executed = await migrator.getExecuted();
      const pending = await migrator.getPending();
      console.log(`executed: ${executed.map((m) => m.name).join(', ') || '-'}`);
      console.log(`pending: ${pending.map((m) => m.name).join(', ') || '-'}`);
      break;
    }
    default:
      throw new Error(`unknown command "${command}" (use up, down or status)`);
  }
} finally {
  await orm.close();
}
