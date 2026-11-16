# Distributed Wagering Processor

Processador de transações de aposta (BET, WIN, LOSS, REFUND, ROLLBACK) sobre wallets, com ledger
append-only, idempotência persistente e duas entradas para o mesmo caso de uso: API HTTP e fila SQS.
Feito para o desafio técnico da Jungle Gaming.

Stack: Bun 1.4, TypeScript strict, NestJS 12, MikroORM 7, PostgreSQL 17, SQS (MiniStack) e Docker Compose.

As decisões de projeto, trade-offs e limitações estão em [ARCHITECTURE.md](ARCHITECTURE.md).

## Requisitos

- [Bun](https://bun.sh) 1.4.4
- Docker com Compose

O SQS local é o [MiniStack](https://hub.docker.com/r/ministackorg/ministack), compatível com a API do
SQS. As imagens do LocalStack passaram a exigir token de autenticação, o que atrapalharia quem for
rodar o projeto.

## Rodando localmente

```bash
docker compose up -d       # Postgres, SQS e criação das filas
bun install
bun run db:migrate
bun run start              # API e workers na porta 3000
```

Todas as variáveis têm valor padrão que aponta para o ambiente do compose, então não é preciso criar
`.env`. O [.env.example](.env.example) lista todas.

Conferindo:

```bash
curl localhost:3000/health/ready
```

## Stack completa em containers, com vários workers

```bash
docker compose --profile app up -d --build --scale worker=3
```

Sobe as migrations (`migrate`), uma instância só de API na porta 3000 (`api`) e três instâncias de
workers (`worker`). Todas usam a mesma imagem e mudam só o `APP_ROLE`:

| `APP_ROLE` | O que roda |
|---|---|
| `api` | API HTTP |
| `worker` | consumer da fila, publisher da outbox e worker de referências pendentes (com health e métricas por HTTP) |
| `all` | tudo junto (padrão para rodar local) |

`docker compose --profile app stop worker` manda SIGTERM: cada worker conclui a mensagem em
andamento, devolve à fila as que ainda não começou e sai.

## Comandos

| Comando | O que faz |
|---|---|
| `bun run start` | sobe a aplicação |
| `bun run typecheck` | checagem de tipos |
| `bun test` | todos os testes |
| `bun run test:unit` | só unidade (domínio e logs) |
| `bun run test:integration` | integração com Postgres e SQS reais |
| `bun run test:concurrency` | concorrência, várias instâncias e recuperação de falhas |
| `bun run db:migrate` | aplica as migrations |
| `bun run db:rollback` | desfaz a última migration |
| `bun run db:status` | migrations aplicadas e pendentes |

Os testes de integração e concorrência precisam do `docker compose up -d` no ar. Eles usam um banco
próprio (`wagering_test`, criado na hora) e filas criadas e apagadas por cada teste, sem tocar no banco
de desenvolvimento. Os testes de concorrência sobem processos reais da aplicação (`bun run src/main.ts`).
O teste de SIGTERM é pulado no Windows, que não tem sinais POSIX.

## API

| Método e rota | Descrição |
|---|---|
| `POST /wallets` | cria a wallet com saldo inicial |
| `GET /wallets/:walletId` | saldo e versão |
| `GET /wallets/:walletId/ledger?limit=&cursor=` | lançamentos, do mais novo para o mais antigo |
| `POST /wallets/:walletId/reconciliation` | compara o saldo gravado com o saldo reconstruído pelo ledger |
| `POST /wagering/transactions` | submete uma transação (header `Idempotency-Key` obrigatório) |
| `GET /wagering/transactions/:transactionId` | transação pelo id interno |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | transação pelo id do provedor |
| `GET /health/live`, `GET /health/ready` | liveness e readiness (Postgres e SQS) |
| `GET /metrics` | métricas no formato Prometheus |

Exemplo:

```bash
curl -s localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"100.00","currency":"BRL"}}'

curl -s localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "<id devolvido acima>",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }'
```

Respostas da submissão: `201` processada, `202` aguardando a referência, `422` rejeitada por regra de
negócio (com `failureCode`), `400` payload inválido, `404` wallet inexistente, `409` conflito de
idempotência e `503` falha transitória (com `Retry-After`). Um reenvio com a mesma key devolve o mesmo
status e corpo, com `idempotentReplay: true`. O mapeamento completo está no ARCHITECTURE.md.

Todo endpoint aceita `X-Correlation-Id`, que é devolvido na resposta e entra nos logs e nos eventos.

## Fila de entrada

O consumer lê `wager-transactions.fifo`. A mensagem segue o formato do enunciado:

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

Use o `walletId` como `MessageGroupId`. Com o AWS CLI (o MiniStack aceita qualquer credencial):

```bash
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
aws --endpoint-url http://localhost:4566 --region us-east-1 sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id <walletId> --message-deduplication-id msg-123 \
  --message-body file://mensagem.json
```

Mensagens que não podem ser processadas vão para `wager-transactions-dlq.fifo`, com os atributos
`errorCode`, `errorMessage` e `attempts`. Os eventos de integração são publicados em
`wallet-events.fifo`.

## Observabilidade

- Logs em JSON no stdout, uma linha por evento, com `correlationId`, `messageId`, `transactionId`,
  `walletId` e `providerId` quando se aplicam. Valores e saldos não são logados. O nível é controlado
  por `LOG_LEVEL`.
- `GET /metrics` em toda instância: transações por status, duplicatas, retries, DLQ, conflitos de lock,
  outbox lag, latência de processamento e divergências de reconciliação.

## Estrutura

```
src/
  domain/          regras de negócio puras: Money, Wallet, WagerTransaction, ledger, eventos
  application/     casos de uso e portas (UnitOfWork, repositórios, publisher)
  infrastructure/  MikroORM, SQS, workers, observabilidade
  http/            controllers, validação de entrada e mapeamento de erro para HTTP
test/
  unit/            domínio e formato dos logs
  integration/     schema, casos de uso, API, outbox, consumer
  concurrency/     corridas, várias instâncias, queda e reinício
```
