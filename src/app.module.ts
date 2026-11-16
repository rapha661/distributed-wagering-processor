import { Module } from '@nestjs/common';
import { ConfigModule } from './infrastructure/config.module';
import { DatabaseModule } from './infrastructure/persistence/database.module';
import { SqsModule } from './infrastructure/messaging/sqs.module';
import { HealthController } from './http/health.controller';

@Module({
  imports: [ConfigModule, DatabaseModule, SqsModule],
  controllers: [HealthController],
})
export class AppModule {}
