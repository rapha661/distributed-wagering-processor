import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { APP_CONFIG, type AppConfig } from './config';
import { NestLogger } from './infrastructure/observability/logging';

const app = await NestFactory.create(AppModule, { bufferLogs: true });
app.useLogger(app.get(NestLogger));
app.enableShutdownHooks();

const config = app.get<AppConfig>(APP_CONFIG);
await app.listen(config.PORT);
