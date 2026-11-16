import {
  CreateQueueCommand,
  DeleteMessageBatchCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

export function testSqsClient(endpoint = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566'): SQSClient {
  return new SQSClient({
    region: 'us-east-1',
    endpoint,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    maxAttempts: 1,
  });
}

export interface TestQueue {
  name: string;
  url: string;
  remove(): Promise<void>;
}

/** Fila FIFO exclusiva do teste, removida no final. */
export async function createTestQueue(sqs: SQSClient, prefix: string, attributes: Record<string, string> = {}): Promise<TestQueue> {
  const name = `${prefix}-${crypto.randomUUID().slice(0, 8)}.fifo`;
  const { QueueUrl } = await sqs.send(
    new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: 'true', ...attributes } }),
  );
  if (!QueueUrl) {
    throw new Error(`could not create ${name}`);
  }
  return { name, url: QueueUrl, remove: () => sqs.send(new DeleteQueueCommand({ QueueUrl })).then(() => undefined) };
}

/** Fila de entrada com redrive para a sua DLQ, como a criada pelo docker compose. */
export async function createConsumerQueues(
  sqs: SQSClient,
  options: { visibilityTimeoutSeconds?: number; maxReceiveCount?: number } = {},
): Promise<{ source: TestQueue; deadLetter: TestQueue }> {
  const deadLetter = await createTestQueue(sqs, 'test-wagers-dlq');
  const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: deadLetter.url, AttributeNames: ['QueueArn'] }));
  const source = await createTestQueue(sqs, 'test-wagers', {
    VisibilityTimeout: String(options.visibilityTimeoutSeconds ?? 30),
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: Attributes?.QueueArn, maxReceiveCount: String(options.maxReceiveCount ?? 5) }),
  });
  return { source, deadLetter };
}

/** Mensagens visíveis e em processamento (recebidas e ainda sem ack). */
export async function queueDepth(sqs: SQSClient, url: string): Promise<{ visible: number; inFlight: number }> {
  const { Attributes = {} } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return {
    visible: Number(Attributes.ApproximateNumberOfMessages ?? 0),
    inFlight: Number(Attributes.ApproximateNumberOfMessagesNotVisible ?? 0),
  };
}

export interface ReceivedMessage {
  body: Record<string, any>;
  attributes: Record<string, string | undefined>;
}

/** Lê e apaga tudo o que estiver na fila até ela ficar vazia (ou atingir `expected`). */
export async function drainQueue(sqs: SQSClient, url: string, expected = Number.POSITIVE_INFINITY): Promise<ReceivedMessage[]> {
  const received: ReceivedMessage[] = [];
  let emptyPolls = 0;
  while (received.length < expected && emptyPolls < 2) {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, MessageAttributeNames: ['All'] }),
    );
    if (Messages.length === 0) {
      emptyPolls += 1;
      continue;
    }
    emptyPolls = 0;
    for (const message of Messages) {
      received.push({
        body: parseBody(message.Body),
        attributes: Object.fromEntries(
          Object.entries(message.MessageAttributes ?? {}).map(([key, value]) => [key, value.StringValue]),
        ),
      });
    }
    await sqs.send(
      new DeleteMessageBatchCommand({
        QueueUrl: url,
        Entries: Messages.map((message, index) => ({ Id: String(index), ReceiptHandle: message.ReceiptHandle ?? '' })),
      }),
    );
  }
  return received;
}

function parseBody(body: string | undefined): Record<string, any> {
  try {
    return JSON.parse(body ?? '{}');
  } catch {
    return { raw: body };
  }
}
