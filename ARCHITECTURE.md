# Arquitetura

## Visão geral

```
 provedor ── HTTP ─────────┐
                           ├──> ProcessWagerTransaction ──> PostgreSQL (um commit: wallet, transação,
 wager-transactions.fifo ──┘                                 │           ledger, inbox e outbox)
        │                                                    │
        └──> wager-transactions-dlq.fifo                     ├──> publisher da outbox ──> wallet-events.fifo
                                                             └──> worker de PENDING_REFERENCE
```

O código tem quatro camadas:

- `domain`: regras de negócio sem dependência de framework, banco ou AWS. `Money`, `Wallet`,
  `WagerTransaction`, `WalletLedgerEntry`, `WagerSettlement` (as regras de BET/WIN/LOSS/REFUND/ROLLBACK),
  eventos, inbox e outbox.
- `application`: casos de uso (`CreateWallet`, `ProcessWagerTransaction`, `ReprocessPendingReferences`,
  `PublishOutbox`, consultas) e as portas que eles usam (`UnitOfWork`, repositórios, `EventPublisher`,
  `Clock`, `IdGenerator`).
- `infrastructure`: MikroORM, SQS, workers em segundo plano e observabilidade.
- `http`: controllers, validação de entrada (zod) e o mapeamento de erro para status HTTP.

A API e o consumer da fila chamam o mesmo `ProcessWagerTransaction`. Uma submissão grava, numa única
transação SQL, a transação, o novo saldo, o lançamento no ledger, o registro de inbox (quando vem da
fila) e os eventos na outbox. Depois do commit, o publisher manda os eventos para a fila de saída.

A mesma imagem roda como API, worker ou as duas coisas, conforme o `APP_ROLE`. Toda a coordenação entre
instâncias acontece no Postgres, por locks de linha e constraints. Nenhuma instância guarda estado em
memória.

## Decisões

### ORM, Money e transação

**MikroORM 7.** As entidades do banco são declaradas com `defineEntity`, sem decorators no domínio. Os
mappers convertem registro em objeto de domínio pelo `rehydrate` de cada classe, e o domínio não sabe que
o ORM existe. O Unit of Work é o `em.fork().transactional()`: cada execução usa um EntityManager novo, e
tudo o que os repositórios registram é gravado num único flush, no commit.

As migrations são SQL escritas à mão (constraints, índices parciais e triggers não saem bem de geração
automática), versionadas e reversíveis. O teste de schema roda up, down e up.

**Money.** No domínio é `bigint` em centavos, com moeda. No banco são duas colunas, `NUMERIC(20,2)` e
`CHAR(3)`. Na borda (API, eventos, fila) é sempre string decimal com duas casas. A entrada passa por uma
regex estrita: até duas casas, sem sinal, sem notação científica, até 18 dígitos inteiros. Valor fora
disso é rejeitado, nunca arredondado. `"25"` e `"25.5"` são aceitos e viram `"25.00"` e `"25.50"`. O
`numeric` do Postgres chega como string e é reidratado sem passar por `number`. Somar valores de moedas
diferentes é erro.

### Concorrência

A estratégia é lock pessimista na linha da wallet. Toda operação que mexe em saldo começa com
`SELECT ... FOR UPDATE` na wallet, dentro da transação, e só então decide.

Os motivos:

- Toda regra que importa depende do estado da mesma wallet: saldo suficiente, a referência existir e
  estar processada, a transação não ter sido revertida antes. A referência é sempre da mesma wallet, então
  um lock por wallet serializa exatamente o que precisa ser serializado.
- Nenhuma operação toca duas wallets. Não há ordem de locks a respeitar nem risco de deadlock entre
  wallets.
- Numa wallet disputada (o caso de 80 + 80 com saldo 100), lock otimista viraria uma sequência de
  conflitos e novas tentativas. O lock pessimista só enfileira.

A espera pelo lock é limitada por `lock_timeout` (5 s por padrão). Estourou, a operação vira
`LOCK_TIMEOUT`: 503 na API, nova tentativa com backoff no consumer. Nada foi gravado.

O `version` da wallet não é usado para lock otimista. Ele numera a cadeia do ledger: cada lançamento
grava o `wallet_version` que gerou. Isso permite uma segunda barreira no banco:

- `CHECK (balance >= 0)` na wallet;
- `UNIQUE (wallet_id, wallet_version)` no ledger, que torna impossível um lost update gravar dois
  lançamentos com a mesma versão;
- um CHECK que obriga `balance_after = balance_before ± amount` em cada lançamento.

### Idempotência e payloadHash

A garantia vem do banco, não de memória: `UNIQUE (idempotency_key)` e
`UNIQUE (provider_id, external_transaction_id)`.

O caso de uso procura a key antes de pegar o lock (um replay não precisa esperar) e de novo depois dele
(para enxergar o que outra instância acabou de commitar). Se duas instâncias correrem com a mesma key, a
perdedora recebe violação de unique, repete uma vez e cai no replay.

O replay devolve o mesmo status HTTP e o mesmo corpo da primeira resposta, com `idempotentReplay: true`.
Para isso a transação guarda `observed_balance`, o saldo no momento da decisão. Transações rejeitadas e
LOSS não têm lançamento no ledger, então esse saldo não poderia ser reconstruído depois.

**Algoritmo do payloadHash.** SHA-256, em hexadecimal, do JSON canônico destes campos: `providerId`,
`externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` (com o valor já
normalizado, então `"25"` e `"25.00"` dão o mesmo hash) e `referenceExternalTransactionId`. O JSON
canônico ordena as chaves de todo objeto, recursivamente, omite propriedades `undefined` e não tem
espaços. A idempotency key e os metadados de transporte (headers, `messageId`, `occurredAt`) ficam de
fora.

Mesma key com hash diferente é `409 IDEMPOTENCY_KEY_REUSED`. Mesmo `(providerId, externalTransactionId)`
com outra key é `409 EXTERNAL_ID_REUSED`.

### Ledger

O ledger é append-only. Triggers recusam UPDATE, DELETE e TRUNCATE em `wallet_ledger_entries`.

Cada transação que move saldo gera um lançamento (`UNIQUE (wallet_id, transaction_id)`). Duas FKs
compostas fecham as brechas de consistência entre tabelas:

- `(wallet_id, currency)` aponta para a wallet, então o lançamento tem a moeda dela;
- `(transaction_id, wallet_id)` aponta para a transação, então o lançamento só existe na wallet da
  própria transação.

Na tabela de transações, um trigger impede mudar uma transação terminal, alterar campos de negócio e
apagar linhas.

A reconciliação (`POST /wallets/:id/reconciliation`) compara o saldo gravado com créditos menos débitos
do ledger, lidos num único snapshot. Uma divergência não é corrigida: ela é logada, contada em métrica e
sinalizada na resposta (`consistent: false` e a diferença).

O ledger não é de partidas dobradas: cada movimento é um único lançamento de débito ou crédito na wallet.

### Outbox

Os eventos são gravados em `outbox_messages` na mesma transação da mudança de estado. Evento confirmado
nunca se perde, e nenhum evento sai antes do commit.

O publisher roda em toda instância com papel de worker:

1. Trava um lote de eventos pendentes com `FOR UPDATE SKIP LOCKED`. Publishers concorrentes não pegam o
   mesmo evento.
2. Publica com `SendMessageBatch` na `wallet-events.fifo`. O `MessageGroupId` é o `aggregateId` (a
   transação, nos eventos de ciclo de vida; a wallet, em `WalletBalanceChanged`) e o
   `MessageDeduplicationId` é o `eventId`.
3. No mesmo commit, marca cada evento como publicado ou agenda nova tentativa (backoff de 1 s a 60 s, sem
   limite de tentativas: evento confirmado não é descartado).

Se o processo morrer depois de publicar e antes do commit, os eventos voltam a ficar pendentes e são
publicados de novo. A entrega é at-least-once. O `eventId` é estável, e quem consome deve descartar
duplicatas por ele. A deduplicação do SQS FIFO (5 minutos) é só uma otimização.

Eventos publicados: `WagerTransactionProcessed`, `WagerTransactionRejected`,
`WagerTransactionPendingReference` e `WalletBalanceChanged`. Todos usam o mesmo envelope (`eventId`,
`eventType`, `aggregateId`, `correlationId`, `causationId`, `occurredAt`, `version`, `data`), com valores
sempre como string decimal.

### Consumer da fila e inbox

O consumer lê `wager-transactions.fifo` em long polling e trata cada mensagem com o mesmo caso de uso da
API.

- **Inbox.** `(consumerName, messageId)` é gravado na mesma transação do resultado, junto com o hash do
  `data` da mensagem. O `messageId` é o do corpo da mensagem, que o produtor controla, e não o id do SQS,
  que muda a cada reenvio. A mesma mensagem entregue de novo cai no replay. O mesmo `messageId` com outro
  conteúdo é erro permanente (`MESSAGE_ID_REUSED`).
- **Ack só depois do commit.** O delete da mensagem acontece depois do commit. Se o processo morrer entre
  os dois, a mensagem volta depois do visibility timeout e cai no inbox. Isso é testado com processos
  reais.

Cada erro tem um destino:

| Erro | Exemplos | Destino |
|---|---|---|
| Resultado de negócio | processada, pendente, rejeitada | ack |
| Permanente | JSON inválido, formato inválido, valor inválido, referência ausente, wallet inexistente, conflito de idempotência | DLQ na hora, sem nova tentativa |
| Transitório ou inesperado | `LOCK_TIMEOUT`, banco fora do ar, erro desconhecido | volta para a fila com backoff de visibilidade (2 s a 60 s) |
| Transitório que esgotou as tentativas | 5 recebimentos por padrão | grava a transação como `FAILED` e manda a mensagem para a DLQ |

A mensagem na DLQ leva os atributos `errorCode`, `errorMessage` e `attempts`. O redrive da fila
(`maxReceiveCount` 5) continua como rede de segurança para mensagens que derrubam o processo antes de
chegar a esse tratamento.

O `FAILED` existe para que a desistência fique registrada. Ele não move saldo e é terminal: um reenvio com
a mesma key devolve o `FAILED` (HTTP 500), e o provedor precisa mandar uma key nova.

Uma wallet inexistente não vira `FAILED`, porque a FK não deixa gravar a transação. A mensagem vai para
a DLQ e pode ser reenviada depois que a wallet existir.

As mensagens de um lote são tratadas uma a uma. Se uma falha, as seguintes do mesmo grupo não esperam por
ela. Segurá-las aumentaria a contagem de recebimentos dessas mensagens até a DLQ, sem que tivessem sido
tentadas. A ordem do FIFO não é usada como garantia: o domínio aceita referência fora de ordem.

**Shutdown.** No SIGTERM, o Nest chama os hooks de desligamento, e os workers param antes de o pool do
banco fechar.

1. O consumer deixa o long polling em curso terminar, em vez de abortá-lo. Mensagens que o SQS já tivesse
   entregue a uma chamada abortada ficariam invisíveis até o visibility timeout vencer.
2. Conclui a mensagem em andamento, incluindo o ack.
3. Devolve na hora (visibilidade 0) as que recebeu e ainda não começou.

O desligamento pode levar até `SQS_CONSUMER_WAIT_SECONDS` (5 s por padrão). O compose dá 30 s aos
workers.

### Referência ainda não recebida (PENDING_REFERENCE)

Uma transação cuja referência ainda não existe, ou ainda está pendente, fica `PENDING_REFERENCE` (202). Ela
guarda o número de tentativas e a próxima data de tentativa.

O worker de referências pendentes pega a próxima transação vencida com `FOR UPDATE SKIP LOCKED` (workers
concorrentes não pegam a mesma), trava a wallet e liquida de novo com as mesmas regras da submissão.

O backoff vai de 2 s a no máximo 5 min, com até 8 tentativas: 2 + 4 + 8 + … + 256 s, cerca de 8,5
minutos no total. Esgotou, a transação é rejeitada com `REFERENCE_NOT_FOUND`, e o evento de rejeição é
publicado.

O raciocínio do limite: a referência normalmente chega em segundos, fora de ordem por causa da fila ou de
uma corrida entre instâncias. Oito minutos e meio cobrem uma instabilidade curta ou uma fila acumulada sem
deixar a transação aberta indefinidamente. Os três valores são configuráveis.

### Contrato HTTP

O mesmo mapeamento vale para todos os endpoints. O corpo de erro é `{ code, message, details? }`.

| Situação | Status | O que o provedor deve fazer | Códigos |
|---|---|---|---|
| Transação processada | 201 | nada | |
| Aguardando a referência | 202 | consultar ou ouvir os eventos | |
| Payload inválido | 400 | corrigir | `INVALID_PAYLOAD`, `INVALID_MONEY`, `INVALID_AMOUNT`, `MISSING_REFERENCE`, `UNSUPPORTED_KIND`, `INVALID_FIELD`, `IDEMPOTENCY_KEY_REQUIRED`, `INVALID_IDEMPOTENCY_KEY`, `INVALID_PARAMETER`, `INVALID_CURSOR` |
| Não encontrado | 404 | | `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND` |
| Conflito | 409 | não reenviar | `IDEMPOTENCY_KEY_REUSED`, `EXTERNAL_ID_REUSED`, `WALLET_ALREADY_EXISTS` |
| Rejeição por regra de negócio (gravada) | 422 | desistir | o `failureCode` da transação |
| Falha transitória (nada gravado) | 503, com `Retry-After: 1` | reenviar a mesma requisição | `LOCK_TIMEOUT`, `DEPENDENCY_UNAVAILABLE` |
| Erro inesperado | 500 | | `INTERNAL_ERROR` |

Uma transação `FAILED` (o consumer desistiu dela) devolve 500 no replay, com o corpo da transação e o
`failureCode` `PROCESSING_FAILED`.

### Estados da transação

```
PENDING ──────────────┬──> PROCESSED
   │                  ├──> REJECTED
   v                  └──> FAILED
PENDING_REFERENCE ────┘    (e PENDING_REFERENCE -> PENDING_REFERENCE a cada nova tentativa)
```

- `PENDING` só existe em memória, durante a submissão. Nunca é gravado.
- `PENDING_REFERENCE` é a espera pela referência, resolvida pelo worker.
- `PROCESSED`, `REJECTED` e `FAILED` são terminais. A entidade recusa qualquer transição a partir deles
  (é erro de programação), e um trigger no banco recusa o UPDATE.

### Taxonomia de failureCode

Os códigos são contrato público: podem ser acrescentados, nunca renomeados.

| Código | Status | Quando |
|---|---|---|
| `INSUFFICIENT_FUNDS` | REJECTED | BET maior que o saldo |
| `REVERSAL_INSUFFICIENT_FUNDS` | REJECTED | estorno que deixaria o saldo negativo (ROLLBACK de um WIN ou de um REFUND já gasto) |
| `CURRENCY_MISMATCH` | REJECTED | moeda da transação diferente da wallet |
| `PLAYER_WALLET_MISMATCH` | REJECTED | `playerId` não é o dono da wallet |
| `REFERENCE_NOT_FOUND` | REJECTED | a referência não chegou dentro das tentativas |
| `REFERENCE_MISMATCH` | REJECTED | a referência é de outro provedor, jogador, wallet, rodada ou moeda |
| `INVALID_REFERENCE_KIND` | REJECTED | tipo não pode referenciar aquele tipo (por exemplo, REFUND de um WIN) |
| `REFERENCE_NOT_PROCESSED` | REJECTED | a referência terminou rejeitada ou com falha |
| `REFERENCE_ALREADY_REVERSED` | REJECTED | a referência já foi estornada |
| `REVERSAL_AMOUNT_MISMATCH` | REJECTED | estorno com valor diferente da referência (não há estorno parcial) |
| `PROCESSING_FAILED` | FAILED | o consumer desistiu depois de esgotar as tentativas |

Em `PLAYER_WALLET_MISMATCH` e `CURRENCY_MISMATCH` o saldo não é devolvido. Seria o saldo de outro
jogador, ou um valor em outra moeda.

### Interpretações de negócio

O enunciado deixa alguns pontos em aberto. Estas foram as escolhas:

1. **Cada transação é estornada no máximo uma vez, por qualquer tipo.** Pela letra do enunciado ("mesmo
   tipo"), uma BET poderia receber um REFUND e um ROLLBACK, e o crédito dobraria. Um índice único parcial
   no banco garante a regra. O ROLLBACK de um REFUND não libera a BET para outro estorno.
2. **WIN e LOSS podem referenciar uma BET**, de forma opcional. Se vier a referência, ela precisa ser da
   mesma rodada, e a transação espera em `PENDING_REFERENCE` enquanto a BET não chega. WIN de uma BET já
   estornada é rejeitado com `REFERENCE_ALREADY_REVERSED`.
3. **Valores.** LOSS aceita `0.00` e nunca move saldo. BET, WIN, REFUND e ROLLBACK exigem valor maior que
   zero (`WIN 0.00` é `INVALID_AMOUNT`).
4. **Wallet inexistente** é 404 e nada é gravado. Se a wallet for criada depois, um reenvio processa
   normalmente.
5. **`playerId` diferente do dono da wallet** é rejeição gravada (`PLAYER_WALLET_MISMATCH`), e não 404.
   A transação fica auditável.
6. **Mesmo `(providerId, externalTransactionId)` com outra idempotency key** é 409 `EXTERNAL_ID_REUSED`.
7. **Referência em `PENDING_REFERENCE`** (por exemplo, o ROLLBACK de um REFUND que ainda espera a BET)
   continua aguardando. Referência rejeitada ou com falha é `REFERENCE_NOT_PROCESSED`.
8. **O ROLLBACK inverte a direção da referência:** de BET é crédito, de WIN ou de REFUND é débito.
9. **`OPENING`** é o crédito interno do saldo inicial, criado junto com a wallet. Ele não pode ser
   submetido pela API nem pela fila, e o `providerId` `internal` é reservado. Saldo inicial zero não gera
   transação nem lançamento.
10. **Uma wallet por jogador e moeda** (`WALLET_ALREADY_EXISTS`).

### Autenticação (não implementada)

Optei por não implementar. O ponto de extensão é o `ProviderAuthGuard` (`src/http/provider-auth.guard.ts`),
aplicado às rotas de wallet e de transação, que hoje deixa tudo passar.

O desenho que eu adotaria:

- Keycloak no compose, com um client por provedor, usando OAuth2 client credentials.
- O provedor pede um token ao Keycloak e manda `Authorization: Bearer`.
- O guard valida o JWT pela JWKS do realm (assinatura, `iss`, `aud` e expiração) e extrai o provedor de
  uma claim do client (por exemplo `provider_id`).
- O `providerId` do payload precisa ser igual ao da claim. Se não for, a resposta é 403. Isso impede um
  provedor de submeter ou consultar transações em nome de outro.
- Health e métricas ficam abertos. A fila continua como canal interno confiável, mas o `providerId` da
  mensagem passa pelas mesmas validações de domínio.

### Várias instâncias e recuperação

Nada depende de uma instância só:

- os locks e as constraints estão no Postgres;
- a outbox e o worker de pendências usam `SKIP LOCKED`;
- o inbox e a idempotency key absorvem redeliveries.

Os testes de concorrência sobem processos reais da aplicação. Para o cenário de queda, a variável
`FAULT_INJECTION=crash-after-commit` faz o processo morrer entre o commit e o ack, como um `kill -9`.
Ela existe só para esses testes.

### Observabilidade

- **Logs:** JSON com pino, uma linha por evento. `correlationId`, `messageId`, `walletId` e `providerId`
  são anexados automaticamente a todo log de uma requisição ou mensagem (via `AsyncLocalStorage`), e
  `transactionId` aparece nos logs de resultado.
  - O `correlationId` vem do header `X-Correlation-Id`, do atributo da mensagem ou do `messageId`, e é
    propagado aos eventos.
  - Valores e saldos não são logados. Como segunda barreira, os campos `money`, `balance` e
    `initialBalance` são redigidos.
- **Métricas** (`GET /metrics`, formato Prometheus):

| Métrica | O que mede |
|---|---|
| `wager_transactions_total{status,source}` | transações liquidadas, por status e origem (`http`, `sqs`, `pending_reference`) |
| `wager_duplicates_total{source}` | submissões repetidas respondidas com replay |
| `wager_retries_total{operation,reason}` | novas tentativas: mensagem da fila, publicação da outbox, referência pendente |
| `wager_messages_dead_lettered_total{code}` | mensagens enviadas para a DLQ, por código |
| `wager_dead_letter_queue_messages` | mensagens paradas na DLQ |
| `wallet_lock_conflicts_total` | locks de wallet que estouraram o timeout ou deram deadlock |
| `outbox_lag_seconds`, `outbox_pending_messages` | idade do evento mais antigo não publicado e o tamanho da fila |
| `wager_processing_duration_seconds{source}` | latência do processamento, do recebimento ao commit |
| `wager_pending_reference_transactions` | transações aguardando a referência |
| `wallet_reconciliation_mismatches_total` | reconciliações com divergência |

  Contadores e latência são por instância (o Prometheus soma). Os gauges de backlog leem o banco e a
  fila a cada coleta e valem para o sistema todo.
- **Health:** `/health/live` só responde. `/health/ready` executa `SELECT 1` no Postgres e consulta a
  fila no SQS.

## Testes

A integração usa Postgres e SQS reais, em containers. Mocks aparecem só para provocar falhas
específicas: um publisher que falha, um Unit of Work que devolve uma falha transitória, um ack perdido.

O invariante final, checado depois de cada cenário, é que o saldo da wallet é igual ao saldo
reconstruído pelo ledger e que a cadeia de versões não tem buracos.

Os cenários de concorrência pedidos e onde estão:

| Cenário | Arquivo |
|---|---|
| A mesma aposta 50 vezes em paralelo, um único débito | `test/concurrency/wallet-concurrency.test.ts` |
| Saldo 100 e duas apostas de 80 simultâneas (20 rodadas) | `wallet-concurrency.test.ts` e, entre instâncias, `multi-instance.test.ts` |
| Wallets distintas em paralelo | `wallet-concurrency.test.ts` |
| 3 processos simultâneos (API e fila) | `test/concurrency/multi-instance.test.ts` |
| Worker morto depois do commit e antes do ack | `test/concurrency/crash-recovery.test.ts` |
| Dois publishers na mesma outbox | `test/concurrency/outbox-publishers.test.ts` |
| REFUND ou ROLLBACK antes da referência | `test/concurrency/out-of-order.test.ts` e `crash-recovery.test.ts` |
| Reinício do serviço com consistência final | `crash-recovery.test.ts` (as 3 instâncias são derrubadas no meio do processamento) |

Na integração estão as constraints do schema, uma violação proposital por garantia (`schema.test.ts`), a
atomicidade entre wallet, transação, ledger, inbox e outbox, o replay, o contrato HTTP, a outbox com o SQS
fora do ar, o consumer (redelivery, DLQ, retry, shutdown) e as métricas.

## Trade-offs e limitações

- **Uma wallet muito disputada tem vazão limitada.** O lock por wallet serializa as operações dela, e a
  vazão fica limitada pelo tempo de commit. Wallets diferentes não se bloqueiam. É o preço de não ter
  conflitos nem estados intermediários.
- **O consumer trata as mensagens de um lote em sequência.** O paralelismo vem de rodar mais instâncias
  (`--scale worker=N`).
- **Ordem dos eventos de saída.** Ela é garantida por agregado (transação ou wallet), não globalmente.
  Duplicatas são possíveis, e quem consome deve descartar por `eventId`.
- **`FAILED` é terminal.** Reenviar da DLQ uma mensagem que virou `FAILED` só repete o resultado. Para
  tentar de novo, o provedor manda uma idempotency key nova.
- **O hash do inbox usa o `data` como chegou.** Ele não normaliza o valor, então reenviar o mesmo
  `messageId` com `"25"` em vez de `"25.00"` conta como conteúdo diferente.
- **O banco não tem um role separado para a aplicação.** A aplicação conecta como dona do schema, e a
  imutabilidade do ledger e das transações terminais depende dos triggers. Em produção, eu daria à
  aplicação um role sem `UPDATE`, `DELETE` e `TRUNCATE` nessas tabelas.
- **A consistência entre saldo e ledger não é checada no commit.** Ela é garantida pelo código e pelas
  constraints de cada lançamento, e verificada pela reconciliação. Uma constraint deferida no próprio
  banco seria um passo a mais.
- **Sem autenticação**, como descrito acima.
- **Sem tracing distribuído (OpenTelemetry) e sem teste de carga.** Os dois são opcionais no enunciado.
- **O desligamento pode esperar o long polling em curso**, até 5 s por padrão.
- **Ambiente local.** O SQS local é o MiniStack, em vez do LocalStack. O teste de SIGTERM com processo
  real é pulado no Windows, que não tem sinais POSIX; ele roda em Linux.
