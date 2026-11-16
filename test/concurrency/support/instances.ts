import { join } from 'node:path';
import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { SubmitWagerCommand } from '../../../src/application/process-wager-transaction';
import { TEST_DATABASE_URL } from '../../integration/support/database';
import { createConsumerQueues, createTestQueue, queueDepth, type TestQueue } from '../../integration/support/sqs';

const ROOT = join(import.meta.dir, '..', '..', '..');

/** Processo real da aplicação (`bun run src/main.ts`), com banco e filas de teste. */
export interface Instance {
  name: string;
  url: string;
  exited: Promise<number>;
  output(): string;
  /** Linhas de log JSON emitidas pelo processo. */
  logs(): Record<string, any>[];
  /** SIGKILL: queda abrupta, sem shutdown. */
  kill(): Promise<void>;
  /** SIGTERM: desligamento gracioso (no Windows não há sinal, e vira queda abrupta). */
  terminate(): Promise<void>;
}

export interface InstanceQueues {
  source: TestQueue;
  deadLetter: TestQueue;
  events: TestQueue;
  remove(): Promise<void>;
}

export async function createInstanceQueues(sqs: SQSClient, visibilityTimeoutSeconds = 30): Promise<InstanceQueues> {
  const { source, deadLetter } = await createConsumerQueues(sqs, { visibilityTimeoutSeconds });
  const events = await createTestQueue(sqs, 'test-events');
  return {
    source,
    deadLetter,
    events,
    remove: async () => {
      await Promise.all([source.remove(), deadLetter.remove(), events.remove()]);
    },
  };
}

/** Configuração de uma instância de teste: intervalos curtos para os testes não esperarem à toa. */
export function instanceEnv(queues: InstanceQueues, extra: Record<string, string> = {}): Record<string, string> {
  return {
    APP_ROLE: 'all',
    DATABASE_URL: TEST_DATABASE_URL,
    DATABASE_POOL_MAX: '5',
    SQS_WAGER_QUEUE: queues.source.name,
    SQS_WAGER_DLQ: queues.deadLetter.name,
    SQS_EVENTS_QUEUE: queues.events.name,
    SQS_CONSUMER_WAIT_SECONDS: '1',
    OUTBOX_POLL_INTERVAL_MS: '100',
    PENDING_REFERENCE_POLL_INTERVAL_MS: '100',
    REFERENCE_RETRY_BASE_MS: '100',
    REFERENCE_RETRY_MAX_MS: '500',
    REFERENCE_RETRY_MAX_ATTEMPTS: '200',
    NO_COLOR: '1',
    ...extra,
  };
}

export async function startInstance(name: string, env: Record<string, string>): Promise<Instance> {
  const port = freePort();
  // o executável do próprio Bun, não o `bun` do PATH: um lançador (ex.: bun.cmd do npm no
  // Windows) ficaria entre o teste e a aplicação, e o kill deixaria a aplicação órfã
  const child = Bun.spawn([process.execPath, 'run', 'src/main.ts'], {
    cwd: ROOT,
    env: { ...process.env, ...env, PORT: String(port) },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const chunks: string[] = [];
  void collect(child.stdout, chunks);
  void collect(child.stderr, chunks);

  const instance: Instance = {
    name,
    url: `http://127.0.0.1:${port}`,
    exited: child.exited,
    output: () => chunks.join(''),
    logs: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line)),
    kill: async () => {
      child.kill('SIGKILL');
      await child.exited;
    },
    terminate: async () => {
      child.kill('SIGTERM');
      await child.exited;
    },
  };

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${name} exited during startup:\n${instance.output()}`);
    }
    const ready = await fetch(`${instance.url}/health/ready`).then(
      (response) => response.ok,
      () => false,
    );
    if (ready) {
      return instance;
    }
    await Bun.sleep(100);
  }
  child.kill('SIGKILL');
  throw new Error(`${name} did not become ready:\n${instance.output()}`);
}

/** Envelope da fila de entrada, no formato do enunciado. */
export function wagerMessage(command: SubmitWagerCommand, messageId = `msg-${crypto.randomUUID()}`) {
  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: { ...command.request, idempotencyKey: command.idempotencyKey },
  };
}

/** Envia na ordem dada; o grupo FIFO é a wallet. */
export async function sendMessages(sqs: SQSClient, queue: TestQueue, messages: ReturnType<typeof wagerMessage>[]) {
  for (let start = 0; start < messages.length; start += 10) {
    await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: queue.url,
        Entries: messages.slice(start, start + 10).map((message, index) => ({
          Id: String(index),
          MessageBody: JSON.stringify(message),
          MessageGroupId: message.data.walletId,
          MessageDeduplicationId: crypto.randomUUID(),
        })),
      }),
    );
  }
}

export async function queueIsEmpty(sqs: SQSClient, queue: TestQueue): Promise<boolean> {
  const depth = await queueDepth(sqs, queue.url);
  return depth.visible === 0 && depth.inFlight === 0;
}

export async function waitFor(condition: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await Bun.sleep(100);
  }
}

function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = server.port;
  server.stop(true);
  if (port === undefined) {
    throw new Error('no free port');
  }
  return port;
}

async function collect(stream: ReadableStream<Uint8Array>, chunks: string[]): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    chunks.push(decoder.decode(chunk, { stream: true }));
  }
}
