# Distributed Wagering Processor

Serviço financeiro que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`,
`ROLLBACK`) vindas de vários provedores de jogos, por HTTP e por SQS. Ele continua correto
quando as mensagens chegam duplicadas, fora de ordem ou ao mesmo tempo em várias instâncias.

- Enunciado: [`docs/CHALLENGE.md`](docs/CHALLENGE.md)
- Decisões, trade-offs e limitações: [`ARCHITECTURE.md`](ARCHITECTURE.md)
- Teste de carga: [`docs/LOAD_TEST.md`](docs/LOAD_TEST.md)
- Diagramas UML (casos de uso, classes, estados, sequência, componentes, implantação): [`docs/uml/Modelo UML.md`](docs/uml/Modelo%20UML.md), revisados pelo agente `revisor-uml` (`.claude/agents/`)

**Stack:** Bun 1.x · TypeScript estrito · NestJS 11 · PostgreSQL 16 · MikroORM 6 (Unit of Work +
migrations) · AWS SQS via LocalStack · Docker Compose.

## Como rodar

Pré-requisitos: [Bun](https://bun.sh) 1.x e Docker com Compose v2.

```bash
bun install
```

### Opção A: tudo em containers (3 instâncias da aplicação)

```bash
docker compose --profile app up -d --build --wait
```

Sobe PostgreSQL, LocalStack (SQS), roda as migrations uma vez e inicia **3 réplicas** da
aplicação nas portas `3000`, `3001` e `3002`. As filas são criadas na subida.

### Opção B: infraestrutura em containers, aplicação local

```bash
bun run infra:up
```

```bash
bun run migration:up
```

```bash
bun run start
```

Para uma segunda ou terceira instância local, rode `PORT=3001 bun run start` em outro terminal.
Todas as variáveis estão em [`.env.example`](.env.example).

## Comandos

| Comando | O que faz |
|---|---|
| `bun run start` | inicia a aplicação (HTTP + consumidor SQS + workers) |
| `bun run dev` | idem, recarregando ao salvar |
| `bun run typecheck` | `tsc --noEmit` em modo estrito |
| `bun run migration:up` / `migration:down` / `migration:status` | migrations versionadas e reversíveis |
| `bun run infra:up` / `infra:down` | sobe/derruba PostgreSQL e LocalStack |
| `bun run test` | testes unitários |
| `bun run test:integration` | integração (PostgreSQL e SQS reais) |
| `bun run test:concurrency` | concorrência (3 instâncias e 3 processos reais) |
| `bun run test:all` | as três suítes em sequência |
| `bun run test:load` | teste de carga contra instâncias em execução |

### Testes

Integração e concorrência usam o PostgreSQL e o LocalStack do Compose (`bun run infra:up`).
Cada arquivo cria o próprio banco e filas com prefixo aleatório, então dá para rodar várias
vezes sem limpar nada. Para apontar para outro lugar:

| Variável | Padrão |
|---|---|
| `TEST_DATABASE_ADMIN_URL` | `postgres://postgres:postgres@localhost:5432/postgres` |
| `TEST_AWS_ENDPOINT_URL` | `http://localhost:4566` |

### Teste de carga

Com a aplicação rodando (por exemplo a opção A):

```bash
LOAD_TARGETS=http://localhost:3000,http://localhost:3001,http://localhost:3002 bun run test:load
```

Parâmetros (`LOAD_DURATION_S`, `LOAD_CONCURRENCY`, `LOAD_HOT_SHARE`...) e resultados medidos em
[`docs/LOAD_TEST.md`](docs/LOAD_TEST.md).

## API

| Método e rota | Descrição |
|---|---|
| `POST /wallets` | cria wallet (saldo inicial gera `OPENING` + `CREDIT` no ledger) |
| `GET /wallets/:walletId` | saldo e versão |
| `GET /wallets/:walletId/ledger?cursor=&limit=` | ledger paginado (cursor opaco e estável) |
| `POST /wallets/:walletId/reconciliation` | compara saldo guardado com o ledger |
| `POST /wagering/transactions` | submete transação (header `Idempotency-Key` obrigatório) |
| `GET /wagering/transactions/:transactionId` | consulta por id interno |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | consulta por id do provedor |
| `GET /health/live`, `GET /health/ready` | liveness e readiness (sem autenticação) |
| `GET /metrics` | métricas Prometheus |

Exemplo:

```bash
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
```

```bash
curl -s -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:transaction-123' -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<id da wallet>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

Status de resposta da submissão: `201` aplicada, `200` replay idêntico, `422` rejeitada por
regra de negócio (com `failureCode`), `202` aguardando referência, `400` payload inválido,
`404` wallet inexistente, `409` conflito de idempotência, `503` falha transitória
(reenvie com a mesma chave). Detalhes em [ARCHITECTURE.md §11](ARCHITECTURE.md#11-api-http-e-mapa-de-status).

### Mensagens SQS

Fila `wager-transactions.fifo` (DLQ `wager-transactions-dlq.fifo`), no formato do enunciado:

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": { "providerId": "provider-a", "externalTransactionId": "transaction-123", "idempotencyKey": "provider-a:transaction-123", "playerId": "...", "walletId": "...", "roundId": "round-987", "gameId": "fortune-chimp", "kind": "BET", "money": { "amount": "25.00", "currency": "BRL" } }
}
```

Use `MessageGroupId = walletId`. Os eventos de integração saem em `wager-events.fifo`.

## Estrutura

```
src/
  shared/ wallet/ wagering/ messaging/   domínio (sem Nest, sem ORM)
  application/                          use cases e portas
  infrastructure/                       PostgreSQL, SQS, HTTP, observabilidade, workers
  auth/                                 ponto de extensão de autenticação
test/
  unit/ integration/ concurrency/ load/ support/
```

## Principais decisões (resumo)

- **Dinheiro** é `bigint` em centavos no domínio e `numeric(18,2)` no banco; nunca `number`.
- **Concorrência:** lock pessimista da linha da wallet (`SELECT ... FOR NO KEY UPDATE`), sem
  lock global; deadlocks são refeitos.
- **Idempotência** persistente por unicidade no schema e `INSERT ... ON CONFLICT DO NOTHING`;
  `payloadHash` = SHA-256 do JSON canônico.
- **Saldo = ledger garantido pelo banco:** ledger imutável por trigger, cadeia contínua e
  *constraint trigger* deferida que barra no COMMIT qualquer saldo sem lançamento.
- **Inbox + transação + ledger + outbox** na mesma transação SQL; eventos só saem depois do
  COMMIT, por publishers concorrentes com `SKIP LOCKED`.
- **Autenticação não implementada** (decisão documentada, com ponto de extensão no código).
