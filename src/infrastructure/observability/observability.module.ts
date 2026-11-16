import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config';
import { type AppLogger, createLogger, LOGGER, NestLogger } from './logging';

@Global()
@Module({
  providers: [
    {
      provide: LOGGER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createLogger(config.LOG_LEVEL),
    },
    {
      provide: NestLogger,
      inject: [LOGGER],
      useFactory: (logger: AppLogger) => new NestLogger(logger),
    },
  ],
  exports: [LOGGER, NestLogger],
})
export class ObservabilityModule {}
