#!/bin/sh
set -eu

ENDPOINT="${SQS_ENDPOINT:-http://localhost:4566}"
MAX_RECEIVE_COUNT="${MAX_RECEIVE_COUNT:-5}"

sqs() {
  aws --endpoint-url "$ENDPOINT" sqs "$@"
}

until sqs list-queues >/dev/null 2>&1; do
  echo "waiting for sqs at $ENDPOINT"
  sleep 1
done

sqs create-queue --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true >/dev/null

DLQ_URL=$(sqs get-queue-url --queue-name wager-transactions-dlq.fifo --query QueueUrl --output text)
DLQ_ARN=$(sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names QueueArn --query Attributes.QueueArn --output text)

sqs create-queue --queue-name wager-transactions.fifo --attributes "{
  \"FifoQueue\": \"true\",
  \"VisibilityTimeout\": \"30\",
  \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"$MAX_RECEIVE_COUNT\\\"}\"
}" >/dev/null

sqs create-queue --queue-name wallet-events.fifo \
  --attributes FifoQueue=true >/dev/null

echo "queues ready"
