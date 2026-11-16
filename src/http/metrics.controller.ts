import { Controller, Get, Header, Inject } from '@nestjs/common';
import { Metrics } from '../infrastructure/observability/metrics';

/** Scrape do Prometheus. Aberto, como os health checks. */
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(Metrics) private readonly metrics: Metrics) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  scrape(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}
