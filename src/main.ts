import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { CONFIG, type AppConfig } from './config/config';
import { PinoNestLogger } from './infrastructure/observability/nest-logger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(PinoNestLogger));
  // SIGTERM/SIGINT disparam beforeApplicationShutdown: o consumidor conclui o que está em andamento.
  app.enableShutdownHooks();
  const config = app.get<AppConfig>(CONFIG);
  await app.listen(config.port, '0.0.0.0');
}

bootstrap().catch((error) => {
  console.error(JSON.stringify({ level: 'fatal', msg: 'falha ao iniciar', error: String(error) }));
  process.exit(1);
});
