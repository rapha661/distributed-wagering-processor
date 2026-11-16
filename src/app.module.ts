import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigModule } from './infrastructure/config.module';
import { DatabaseModule } from './infrastructure/persistence/database.module';
import { SqsModule } from './infrastructure/messaging/sqs.module';
import { ObservabilityModule } from './infrastructure/observability/observability.module';
import { ApiExceptionFilter } from './http/api-exception.filter';
import { CorrelationIdMiddleware } from './http/correlation-id.middleware';
import { HealthController } from './http/health.controller';
import { MetricsController } from './http/metrics.controller';
import { WageringModule } from './wagering.module';

@Module({
  imports: [ConfigModule, DatabaseModule, SqsModule, ObservabilityModule, WageringModule],
  controllers: [HealthController, MetricsController],
  providers: [{ provide: APP_FILTER, useClass: ApiExceptionFilter }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
