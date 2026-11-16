import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { APP_CONFIG, type AppConfig } from '../config';

const CHECK_TIMEOUT_MS = 2_000;

type CheckStatus = 'up' | 'down';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(SQSClient) private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    const [postgres, sqs] = await Promise.all([this.checkPostgres(), this.checkSqs()]);
    const body = {
      status: postgres === 'up' && sqs === 'up' ? 'ok' : 'unavailable',
      checks: { postgres, sqs },
    };
    if (body.status !== 'ok') {
      throw new ServiceUnavailableException(body);
    }
    return body;
  }

  private async checkPostgres(): Promise<CheckStatus> {
    try {
      // no MikroORM 7 a conexão é lazy: checkConnection() só reflete conexões já abertas
      await withTimeout(this.orm.em.getConnection().execute('select 1'), CHECK_TIMEOUT_MS);
      return 'up';
    } catch {
      return 'down';
    }
  }

  private async checkSqs(): Promise<CheckStatus> {
    try {
      await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.config.SQS_WAGER_QUEUE }), {
        abortSignal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      return 'up';
    } catch {
      return 'down';
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
