import { loadConfig } from '../../config/config';
import { createOrm } from './orm';

/** Uso: bun run src/infrastructure/persistence/migrate.ts <up|down|status> */
async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  const config = loadConfig();
  const orm = await createOrm({ databaseUrl: config.databaseUrl, poolMax: 2 });
  try {
    const migrator = orm.getMigrator();
    if (command === 'up') {
      const applied = await migrator.up();
      console.log(`migrations aplicadas: ${applied.map((m) => m.name).join(', ') || '(nenhuma)'}`);
    } else if (command === 'down') {
      const reverted = await migrator.down();
      console.log(`migrations revertidas: ${reverted.map((m) => m.name).join(', ') || '(nenhuma)'}`);
    } else if (command === 'status') {
      const pending = await migrator.getPendingMigrations();
      const executed = await migrator.getExecutedMigrations();
      console.log(`executadas: ${executed.map((m) => m.name).join(', ') || '(nenhuma)'}`);
      console.log(`pendentes:  ${pending.map((m) => m.name).join(', ') || '(nenhuma)'}`);
    } else {
      throw new Error(`comando desconhecido: ${command}`);
    }
  } finally {
    await orm.close(true);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
