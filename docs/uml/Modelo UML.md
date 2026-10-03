---
tags: [wagering, uml, modelo]
descreve: árvore de trabalho sobre o commit c7143e6 (implementação ainda não commitada)
atualizado: 2026-10-03
---
# Modelo UML do Distributed Wagering Processor

Diagramas do sistema como ele está no código, em Mermaid (o GitHub e o Obsidian desenham
sem plugin). As regras de notação estão no [Guia UML](Guia%20UML.md), com seção e página do
livro do Guedes. Quem revisa o modelo é o agente [`revisor-uml`](Agente%20UML.md).

Documentação viva (§1.2.6): mudou o código, muda este arquivo. O cabeçalho registra o
commit que o modelo descreve.

| # | Diagrama | Responde | Livro |
|---|---|---|---|
| 1 | Casos de uso | quem faz o quê | cap. 3 |
| 2 | Pacotes (camadas) | quem depende de quem | §6.5 |
| 3 | Classes do domínio | as regras e seus dados | cap. 4 |
| 4 | Classes da aplicação e portas | controle, interfaces e quem as realiza | §4.4, §4.6.3-4.6.5, §4.16 |
| 5 | Tabelas | o schema e suas garantias | §4.14-4.15 |
| 6 | Máquina de estados: WagerTransaction | para onde uma transação pode ir | cap. 9 |
| 7 | Máquina de estados: evento da outbox | publicação e retry | cap. 9 |
| 8 | Máquina de estados: mensagem SQS | ack, retry e DLQ | cap. 9 |
| 9 | Sequência: submeter pela API | a ordem das conversas numa aposta | cap. 7, §7.8 |
| 10 | Sequência: consumir do SQS | inbox e ack depois do COMMIT | cap. 7 |
| 11 | Sequência: referência fora de ordem | REFUND antes da BET | cap. 7 |
| 12 | Sequência: publicar a outbox | publishers concorrentes | cap. 7 |
| 13 | Atividade com partições | o processamento por responsável | cap. 10, §10.22 |
| 14 | Componentes | interfaces fornecidas e requeridas | cap. 12 |
| 15 | Implantação | onde cada parte roda | cap. 13 |

---

## 1. Casos de uso

Atores são papéis (§3.1). O **Tempo** dispara o reprocessamento e a publicação, como o ator
temporal dos exemplos do livro. `<<include>>` é obrigatório; `<<extend>>` é opcional e traz a
condição escrita (§3.8-3.11).

```mermaid
flowchart LR
    Provedor(["👤 Provedor de jogos"])
    Operador(["👤 Operação / backoffice"])
    Tempo(["⏱ Tempo (workers)"])
    Orq(["👤 Orquestrador (Docker/K8s)"])
    Consumidor(["👤 Consumidor de eventos"])

    subgraph Sistema["Distributed Wagering Processor"]
        UC1(["Submeter transação<br/>(HTTP ou SQS)"])
        UC1a(["Validar idempotência"])
        UC1b(["Aplicar regra de negócio"])
        UC1c(["Aguardar referência"])
        UC2(["Consultar transação"])
        UC3(["Criar wallet"])
        UC4(["Consultar saldo e ledger"])
        UC5(["Reconciliar wallet"])
        UC6(["Reprocessar pendentes"])
        UC7(["Publicar eventos"])
        UC8(["Verificar saúde e métricas"])
    end

    Provedor --- UC1
    Provedor --- UC2
    Operador --- UC3
    Operador --- UC4
    Operador --- UC5
    Tempo --- UC6
    Tempo --- UC7
    UC7 --- Consumidor
    Orq --- UC8

    UC1 -. "<<include>>" .-> UC1a
    UC1 -. "<<include>>" .-> UC1b
    UC1c -. "<<extend>><br/>[referência ausente]" .-> UC1b
    UC6 -. "<<include>>" .-> UC1b
```

**Submeter transação: cenários (§3.4)**

| Cenário | Condição | Resultado |
|---|---|---|
| Principal | chave nova, regras atendidas | `PROCESSED`, saldo movimentado, 201 / ack |
| Alternativo | mesma chave e mesmo payload | resultado original, 200 / ack |
| Alternativo | referência ausente | `PENDING_REFERENCE`, 202 / ack |
| Exceção | regra de negócio violada | `REJECTED` com `failureCode`, 422 / ack |
| Exceção | mesma chave, payload diferente | 409 / DLQ, nada persistido |
| Exceção | payload inválido ou wallet inexistente | 400 ou 404 / DLQ, nada persistido |
| Exceção | PostgreSQL indisponível | 503 / retry com backoff |

Restrição (regra de negócio): saldo nunca negativo; cada referência é revertida uma única vez.

## 2. Pacotes (camadas)

Dependência sempre de fora para dentro (§6.2, §6.5). O domínio não depende de nenhum
pacote de framework.

```mermaid
flowchart TB
    subgraph infra["infrastructure"]
        http["http<br/>controllers, filtro"]
        messaging["messaging<br/>consumidor, publisher SQS"]
        persistence["persistence<br/>repositórios, UoW, migrations"]
        observability["observability"]
        workers["workers + runtime"]
    end
    subgraph app["application"]
        services["serviços (casos de uso)"]
        ports["ports<br/>interfaces"]
    end
    subgraph domain["domínio"]
        shared["shared"]
        wallet["wallet"]
        wagering["wagering"]
        msgdomain["messaging"]
    end
    composition["composition / app.module"]

    http --> services
    messaging --> services
    workers --> services
    persistence -. "realiza" .-> ports
    messaging -. "realiza EventPublisher" .-> ports
    observability -. "realiza Metrics, AppLogger" .-> ports
    services --> ports
    services --> domain
    ports --> domain
    composition --> infra
    composition --> app
```

## 3. Classes do domínio

Construtor privado, criação por factories e `rehydrate` para reconstruir do banco.
`<<enumeration>>` conforme §4.6.1. `WalletLedgerEntry` só é criado por `Wallet` (dependência
`cria`, §4.2.9).

```mermaid
classDiagram
    direction LR
    class Money {
        <<value object>>
        -minor: bigint
        +currency: string
        +from(props)$ Money
        +fromSigned(props)$ Money
        +zero(currency)$ Money
        +add(other) Money
        +subtract(other) Money
        +negate() Money
        +isLessThan(other) boolean
        +equals(other) boolean
        +toJSON() MoneyProps
    }
    class Wallet {
        <<aggregate root>>
        +id: string
        +playerId: string
        +currency: string
        -_balance: Money
        -_version: number
        +open(props)$ OpenedWallet
        +rehydrate(state)$ Wallet
        +canDebit(money) boolean
        +debit(movement) WalletLedgerEntry
        +credit(movement) WalletLedgerEntry
    }
    class WalletLedgerEntry {
        <<imutável>>
        +id: string
        +walletId: string
        +transactionId: string
        +direction: LedgerDirection
        +money: Money
        +balanceBefore: Money
        +balanceAfter: Money
        +create(props)$ WalletLedgerEntry
        +isBalanced() boolean
        +signedMoney Money
    }
    class WagerTransaction {
        +id: string
        +providerId: string
        +externalTransactionId: string
        +idempotencyKey: string
        +payloadHash: string
        +kind: WagerTransactionKind
        +money: Money
        +referenceExternalTransactionId: string
        -_status: WagerTransactionStatus
        -_resultBalance: Money
        -_pendingAttempts: number
        +create(props)$ WagerTransaction
        +createOpening(props, balance)$ WagerTransaction
        +markProcessed(refId, at, balance)
        +markPendingReference(now, policy)
        +registerReferenceRetry(now, policy) ReferenceRetryResult
        +reject(code, balance)
        +fail(code)
        +isTerminal() boolean
        +affectsBalance() boolean
        +matchesPayload(hash) boolean
        +ledgerDirectionFor(reference) LedgerDirection
        +checkReference(reference) FailureCode
    }
    class WagerTransactionKind {
        <<enumeration>>
        OPENING
        BET
        WIN
        LOSS
        REFUND
        ROLLBACK
    }
    class WagerTransactionStatus {
        <<enumeration>>
        PENDING
        PENDING_REFERENCE
        PROCESSED
        REJECTED
        FAILED
    }
    class LedgerDirection {
        <<enumeration>>
        DEBIT
        CREDIT
    }
    class FailureCode {
        <<enumeration>>
        INSUFFICIENT_FUNDS
        REVERSAL_WOULD_OVERDRAW
        REFERENCE_NOT_FOUND
        REFERENCE_NOT_PROCESSED
        REFERENCE_MISMATCH
        REFERENCE_KIND_INVALID
        AMOUNT_MISMATCH
        ALREADY_REVERSED
        CURRENCY_MISMATCH
        PLAYER_WALLET_MISMATCH
        INTERNAL_PERMANENT_ERROR
    }
    class IntegrationEvent~T~ {
        <<abstract>>
        +eventType: string*
        +version: number*
        +eventId: string
        +aggregateId: string
        +correlationId: string
        +data: T
        +toJSON() envelope
    }
    class WagerTransactionProcessed
    class WagerTransactionRejected
    class WagerTransactionPendingReference
    class WalletBalanceChanged
    class InboxMessage {
        +messageId: string
        +consumerName: string
        +payloadHash: string
        +receive(props)$ InboxMessage
        +markProcessed(at)
    }
    class OutboxMessage {
        +id: string
        +eventType: string
        +payload: object
        -_attempts: number
        -_publishedAt: Date
        +enqueue(event)$ OutboxMessage
        +orderingKey string
        +markPublished(at)
        +scheduleRetry(now)
    }

    Wallet *-- "1" Money : saldo
    Wallet ..> WalletLedgerEntry : cria
    WalletLedgerEntry *-- "3" Money
    WalletLedgerEntry --> LedgerDirection
    WagerTransaction *-- "1" Money
    WagerTransaction --> WagerTransactionKind
    WagerTransaction --> WagerTransactionStatus
    WagerTransaction --> "0..1" FailureCode
    WagerTransaction ..> LedgerDirection : decide
    WagerTransaction "0..*" --> "0..1" WagerTransaction : referencia
    IntegrationEvent <|-- WagerTransactionProcessed
    IntegrationEvent <|-- WagerTransactionRejected
    IntegrationEvent <|-- WagerTransactionPendingReference
    IntegrationEvent <|-- WalletBalanceChanged
    OutboxMessage ..> IntegrationEvent : enqueue
```

## 4. Classes da aplicação e portas

Camadas do livro: `<<boundary>>` fala com o ator, `<<control>>` coordena, `<<entity>>` é o
domínio (§4.6.3-4.6.5). Interfaces fornecidas e realizadas (§4.4, §4.2.10). Os repositórios
seguem o padrão Repository (§4.16, §7.11).

```mermaid
classDiagram
    direction LR
    class WageringController {
        <<boundary>>
        +submit(body, idempotencyKey)
        +byId(id)
        +byProvider(providerId, externalId)
    }
    class WalletsController {
        <<boundary>>
        +create(body)
        +get(walletId)
        +ledger(walletId, cursor, limit)
        +reconcile(walletId)
    }
    class WagerMessageHandler {
        <<boundary>>
        +handle(body, receiveCount) Disposition
    }
    class WagerProcessingService {
        <<control>>
        +submit(command, ctx) WagerOutcome
        +reprocessNextPending() boolean
        -apply(repos, tx, env)
        -withConflictRetry(work)
    }
    class WalletService {
        <<control>>
        +create(input, correlationId) WalletView
        +listLedger(walletId, cursor, limit)
        +reconcile(walletId) ReconciliationView
    }
    class OutboxPublisherService {
        <<control>>
        +publishBatch(batchSize) PublishBatchResult
    }
    class UnitOfWork {
        <<interface>>
        +run(work) T
        +read(work) T
    }
    class Repositories {
        <<interface>>
        wallets: WalletRepository
        transactions: WagerTransactionRepository
        ledger: LedgerRepository
        inbox: InboxRepository
        outbox: OutboxRepository
    }
    class EventPublisher {
        <<interface>>
        +publish(message)
        +publishBatch(messages) failures
    }
    class MikroUnitOfWork
    class PgRepositorios
    class SqsEventPublisher

    WageringController --> WagerProcessingService
    WageringController --> WalletService
    WalletsController --> WalletService
    WagerMessageHandler --> WagerProcessingService
    WagerProcessingService --> UnitOfWork
    WalletService --> UnitOfWork
    OutboxPublisherService --> UnitOfWork
    OutboxPublisherService --> EventPublisher
    UnitOfWork ..> Repositories : entrega
    UnitOfWork <|.. MikroUnitOfWork
    Repositories <|.. PgRepositorios
    EventPublisher <|.. SqsEventPublisher
```

## 5. Tabelas

Mapeamento de classes em tabelas com o estereótipo `<<table>>` (§4.15.1) e chaves
estrangeiras (§4.15.2). As restrições escritas abaixo de cada tabela são as que o banco
garante sozinho.

```mermaid
classDiagram
    direction LR
    class wallets {
        <<table>>
        PK id uuid
        player_id text
        currency char(3)
        balance numeric(18,2)
        version int
        UQ (player_id, currency)
        CK balance >= 0
        TG trg_wallet_matches_ledger (deferida, no COMMIT)
    }
    class wager_transactions {
        <<table>>
        PK id uuid
        FK wallet_id
        FK reference_transaction_id
        provider_id, external_transaction_id
        idempotency_key, payload_hash
        kind, status, failure_code
        amount numeric(18,2), currency
        result_balance, pending_attempts, next_attempt_at
        UQ (provider_id, external_transaction_id)
        UQ (provider_id, idempotency_key)
        UQ parcial reference_transaction_id [REFUND/ROLLBACK PROCESSED]
        TG terminal imutável, sem DELETE
    }
    class wallet_ledger_entries {
        <<table>>
        PK seq bigint identity
        UQ id uuid
        FK wallet_id
        FK transaction_id
        direction, amount, currency
        balance_before, balance_after
        UQ (transaction_id, wallet_id)
        CK balance_after = before ± amount
        TG imutável, cadeia contínua
    }
    class inbox_messages {
        <<table>>
        PK (consumer_name, message_id)
        payload_hash
        received_at, processed_at
    }
    class outbox_messages {
        <<table>>
        PK seq bigint identity
        UQ id uuid (eventId)
        ordering_key (walletId)
        event_type, payload jsonb
        attempts, next_attempt_at, published_at
        IX parcial pendentes (seq), (ordering_key, seq)
    }
    wallets "1" <-- "0..*" wager_transactions : wallet_id
    wallets "1" <-- "0..*" wallet_ledger_entries : wallet_id
    wager_transactions "1" <-- "0..1" wallet_ledger_entries : transaction_id
    wager_transactions "0..1" <-- "0..*" wager_transactions : reference_transaction_id
```

## 6. Máquina de estados: WagerTransaction

Fonte: `TRANSITIONS` em `src/wagering/domain/wager-transaction.ts`. A trigger
`trg_wager_transactions_terminal` impede no banco qualquer mudança depois de um estado final.
Autotransição para as tentativas de referência (§9.8); escolha com guardas completas (§9.9).

```mermaid
stateDiagram-v2
    [*] --> PENDING : create() / INSERT ON CONFLICT DO NOTHING
    state escolha <<choice>>
    PENDING --> escolha : apply() com a wallet travada
    escolha --> PROCESSED : [regras atendidas] / movimenta saldo, grava ledger e eventos
    escolha --> REJECTED : [regra violada] / failureCode, evento Rejected
    escolha --> PENDING_REFERENCE : [referência ausente ou ainda pendente] / agenda tentativa
    PENDING --> FAILED : erro permanente (permitida pelo domínio, não usada pelo código)
    PENDING_REFERENCE --> PENDING_REFERENCE : tentativa [referência ausente e tentativas abaixo do máximo] / backoff
    PENDING_REFERENCE --> PROCESSED : tentativa [referência PROCESSED e válida]
    PENDING_REFERENCE --> REJECTED : tentativa [tentativas esgotadas] / REFERENCE_NOT_FOUND
    PENDING_REFERENCE --> FAILED : erro permanente no reprocessamento
    PROCESSED --> [*]
    REJECTED --> [*]
    FAILED --> [*]
```

`PENDING` nunca é visível fora da transação SQL: a linha nasce e sai desse estado antes do
COMMIT. Para as outras transações, uma operação aparece já em um dos outros quatro estados.
`OPENING` nasce direto em `PROCESSED` (`createOpening`).

## 7. Máquina de estados: evento da outbox

Fonte: `OutboxMessage` e `OutboxPublisherService`.

```mermaid
stateDiagram-v2
    [*] --> Pendente : enqueue() na transação do fato
    Pendente --> Reivindicado : lockDue [devido e sem anterior da wallet em backoff] / FOR UPDATE SKIP LOCKED
    Reivindicado --> Publicado : SQS aceitou / markPublished + COMMIT
    Reivindicado --> EmBackoff : SQS recusou / scheduleRetry (1s ... 60s)
    Reivindicado --> Pendente : processo morreu antes do COMMIT (republica com o mesmo eventId)
    EmBackoff --> Pendente : next_attempt_at venceu
    Publicado --> [*]
```

## 8. Máquina de estados: mensagem SQS no consumidor

Fonte: `SqsTransactionConsumer` e `WagerMessageHandler`. Ponto de saída para o caso de
falha do processo (§9.17).

```mermaid
stateDiagram-v2
    [*] --> Recebida : ReceiveMessage (long poll)
    Recebida --> AguardandoGrupo : [há mensagem anterior do mesmo grupo no lote]
    AguardandoGrupo --> Processando : anterior terminou com ack
    AguardandoGrupo --> Devolvida : anterior foi para retry, ou shutdown
    Recebida --> Processando : [primeira do grupo]
    state decisao <<choice>>
    Processando --> decisao : handler terminou (COMMIT feito ou desfeito)
    decisao --> Confirmada : [sucesso, rejeição de negócio ou duplicata] / DeleteMessage
    decisao --> Devolvida : [transitório e tentativas abaixo do máximo] / ChangeMessageVisibility(backoff)
    decisao --> NaDLQ : [permanente ou tentativas esgotadas] / envia à DLQ e apaga
    Devolvida --> Recebida : visibility timeout venceu
    Processando --> Devolvida : processo morreu (volta após o visibility timeout)
    Confirmada --> [*]
    NaDLQ --> [*]
```

## 9. Sequência: submeter uma BET pela API

Caixa-branca (§7.10): entram tela, controle, repositórios e banco. O fragmento `critical`
(§7.8, p. 292) é a transação SQL: não pode ser interrompida pela metade. `alt` (p. 286)
para os desfechos. Mensagens de retorno tracejadas (§7.3.3).

```mermaid
sequenceDiagram
    autonumber
    actor P as Provedor
    participant C as WageringController<br/>«boundary»
    participant S as WagerProcessingService<br/>«control»
    participant U as MikroUnitOfWork
    participant R as Repositórios
    participant DB as PostgreSQL

    P->>C: POST /wagering/transactions + Idempotency-Key
    C->>C: parseSubmitCommand() (zod, Money.from)
    C->>S: submit(command, ctx)
    S->>S: computePayloadHash() (SHA-256 do JSON canônico)
    S->>U: run(work)
    critical transação SQL (BEGIN ... COMMIT)
        U->>DB: BEGIN
        S->>R: insertIfAbsent(tx PENDING)
        R->>DB: INSERT ... ON CONFLICT DO NOTHING RETURNING id
        alt linha já existia
            R->>DB: SELECT por (provider_id, idempotency_key)
            alt mesmo payloadHash
                S-->>C: replay (resultado gravado)
            else payloadHash diferente
                S-->>C: IdempotencyConflictError
            end
        else linha nova
            S->>R: findByIdForUpdate(wallet)
            R->>DB: SELECT ... FOR NO KEY UPDATE
            alt regra violada
                S->>R: save(REJECTED) + outbox.enqueue(Rejected)
            else regras atendidas
                S->>R: updateBalance(wallet, version)
                S->>R: ledger.insert(entry)
                S->>R: save(PROCESSED, resultBalance)
                S->>R: outbox.enqueue(Processed, BalanceChanged)
                S->>R: wakeDependents()
            end
        end
        U->>DB: COMMIT (trigger deferida: saldo = ledger)
    end
    U-->>S: outcome
    S-->>C: WagerOutcome
    C-->>P: 201 / 200 / 422 / 202 / 409
```

Deadlock ou falha de serialização dentro do `critical` desfaz tudo e o `withConflictRetry`
repete a transação inteira (até 6 tentativas).

## 10. Sequência: consumir uma mensagem do SQS

Mensagens assíncronas com seta aberta (§7.3.7). `break` (p. 291) para o erro permanente,
que interrompe o fluxo normal e vai para a DLQ.

```mermaid
sequenceDiagram
    autonumber
    participant Q as wager-transactions.fifo
    participant K as SqsTransactionConsumer
    participant H as WagerMessageHandler<br/>«boundary»
    participant S as WagerProcessingService
    participant DB as PostgreSQL
    participant D as wager-transactions-dlq.fifo

    K->>Q: ReceiveMessage (long poll)
    Q-->>K: mensagens (por MessageGroupId = walletId)
    loop cada mensagem do grupo, em ordem
        K->>H: handle(body, receiveCount)
        H->>H: valida envelope, parseSubmitCommand()
        break envelope ou payload inválido
            H-->>K: dead-letter
            K-)D: SendMessage (motivo)
            K-)Q: DeleteMessage
        end
        H->>S: submit(command, inbox = consumerName + messageId)
        S->>DB: BEGIN, INSERT inbox ON CONFLICT DO NOTHING
        alt inbox já existia
            S-->>H: resultado original (duplicata)
        else nova
            S->>DB: mesmo fluxo do diagrama 9
        end
        S->>DB: COMMIT (ou ROLLBACK em erro)
        S-->>H: outcome ou erro
        alt sucesso, rejeição de negócio ou duplicata
            H-->>K: ack
            K-)Q: DeleteMessage (só depois do COMMIT)
        else erro transitório e tentativas abaixo do máximo
            H-->>K: retry(delay)
            K-)Q: ChangeMessageVisibility(delay) para esta e as seguintes do grupo
        else erro permanente (conflito, wallet inexistente) ou tentativas esgotadas
            H-->>K: dead-letter
            K-)D: SendMessage (motivo)
            K-)Q: DeleteMessage
        end
    end
```

## 11. Sequência: REFUND antes da BET

`par` (p. 290): a BET e o worker andam em paralelo, em instâncias diferentes.

```mermaid
sequenceDiagram
    autonumber
    actor P as Provedor
    participant A as Instância A (API)
    participant B as Instância B (API)
    participant W as Instância C (worker)
    participant DB as PostgreSQL

    P->>A: REFUND (referência = bet-1)
    A->>DB: BEGIN, insere REFUND, trava wallet, busca bet-1
    DB-->>A: não existe
    A->>DB: status PENDING_REFERENCE, next_attempt_at = agora + 5s, evento PendingReference, COMMIT
    A-->>P: 202
    par BET chega
        P->>B: BET bet-1
        B->>DB: processa a BET, wakeDependents (next_attempt_at = agora), COMMIT
        B-->>P: 201
    and worker em laço
        loop a cada PENDING_POLL_MS
            W->>DB: lockDuePendingReference (FOR NO KEY UPDATE SKIP LOCKED, 1 linha)
            alt referência PROCESSED e válida
                W->>DB: apply() credita, PROCESSED, COMMIT
            else ainda ausente e tentativas abaixo do máximo
                W->>DB: pendingAttempts + 1, novo next_attempt_at
            else tentativas esgotadas
                W->>DB: REJECTED REFERENCE_NOT_FOUND, evento Rejected
            end
        end
    end
```

## 12. Sequência: publicar a outbox

Vários publishers ao mesmo tempo (`par`); `SKIP LOCKED` garante que cada evento seja
reivindicado por um só.

```mermaid
sequenceDiagram
    autonumber
    participant P1 as Publisher instância 1
    participant P2 as Publisher instância 2
    participant DB as PostgreSQL
    participant E as wager-events.fifo

    par instância 1
        P1->>DB: BEGIN, lockDue(50) FOR UPDATE SKIP LOCKED
        DB-->>P1: eventos 1..50
        P1->>E: SendMessageBatch (10 por chamada, dedupId = eventId)
        P1->>DB: markPublished, COMMIT
    and instância 2
        P2->>DB: BEGIN, lockDue(50) FOR UPDATE SKIP LOCKED
        DB-->>P2: eventos 51..100 (pula os travados)
        P2->>E: SendMessageBatch
        alt SQS recusou um evento
            P2->>DB: recordFailure (attempts + 1, next_attempt_at)
        end
        P2->>DB: markPublished dos aceitos, COMMIT
    end
```

## 13. Atividade com partições: processar uma transação

Cada ação na partição de quem a executa (§10.22). Toda decisão com guarda em todas as saídas
(§10.6). A região interrompível (§10.23) é a transação SQL: até o COMMIT, qualquer falha
desfaz tudo; depois dele, nada volta atrás.

```mermaid
flowchart TB
    subgraph Prov["Provedor"]
        I((●)) --> Envia[Enviar transação com Idempotency-Key]
        Recebe[Receber resposta]
        Reenvia[Reenviar com a mesma chave]
    end
    subgraph Ent["API / Consumidor SQS"]
        Valida[Validar payload e Money]
        V{válido?}
        Hash[Calcular payloadHash]
        Resp[Responder ou dar ack]
    end
    subgraph Banco["PostgreSQL (região interrompível: transação SQL)"]
        Ins[Inserir transação PENDING]
        Existe{já existia?}
        Mesmo{mesmo payload?}
        Trava[Travar wallet]
        Regra{regras atendidas?}
        Ref{referência ausente?}
        Mov[Movimentar saldo e gravar ledger]
        Rej[Gravar REJECTED]
        Pend[Gravar PENDING_REFERENCE]
        Out[Gravar eventos na outbox]
        Commit[COMMIT: conferir saldo = ledger]
    end
    subgraph Pub["Publisher da outbox"]
        Publica[Publicar eventos no SQS]
        F((◉))
    end

    Envia --> Valida --> V
    V -- "[não]" --> Resp
    V -- "[sim]" --> Hash --> Ins --> Existe
    Existe -- "[sim]" --> Mesmo
    Mesmo -- "[sim] replay" --> Resp
    Mesmo -- "[não] conflito" --> Resp
    Existe -- "[não]" --> Trava --> Ref
    Ref -- "[sim]" --> Pend --> Out
    Ref -- "[não]" --> Regra
    Regra -- "[sim]" --> Mov --> Out
    Regra -- "[não]" --> Rej --> Out
    Out --> Commit --> Resp --> Recebe
    Commit -. "depois do COMMIT" .-> Publica --> F
    Recebe -- "[sem resposta]" --> Reenvia --> Valida
```

## 14. Componentes

Interfaces fornecidas (bola) e requeridas (soquete) aparecem como rótulos nas ligações
(§12.2).

```mermaid
flowchart LR
    subgraph app["«component» wagering-app (Bun + NestJS)"]
        httpc["«component» API HTTP"]
        cons["«component» Consumidor SQS"]
        core["«component» Núcleo<br/>(WagerProcessingService, WalletService)"]
        pubw["«component» Publisher da outbox"]
        pendw["«component» Worker de referências"]
        persist["«component» Persistência<br/>(MikroORM + SQL)"]
        obs["«component» Observabilidade"]
    end
    pg[("«component» PostgreSQL")]
    sqs[["«component» SQS (LocalStack)"]]

    httpc -- "requer: submit, consultas" --> core
    cons -- "requer: submit" --> core
    pendw -- "requer: reprocessNextPending" --> core
    pubw -- "requer: UnitOfWork, EventPublisher" --> persist
    core -- "requer: UnitOfWork" --> persist
    core -- "requer: Metrics, AppLogger" --> obs
    persist -- "requer: SQL" --> pg
    cons -- "requer: Receive/Delete/ChangeVisibility" --> sqs
    pubw -- "requer: SendMessageBatch" --> sqs
    obs -- "fornece: /metrics, /health" --> httpc
```

## 15. Implantação

Nós `<<device>>`/`<<executionEnvironment>>` e artefatos (§13.1-13.5), como no
`docker-compose.yml`.

```mermaid
flowchart TB
    subgraph host["«device» Host Docker"]
        subgraph app1["«executionEnvironment» container app (réplica 1..3)"]
            art1["«artifact» src/main.ts<br/>bun run"]
        end
        subgraph mig["«executionEnvironment» container migrate (uma vez)"]
            art2["«artifact» migrate.ts up"]
        end
        subgraph pgn["«executionEnvironment» postgres:16-alpine"]
            db[("wagering")]
        end
        subgraph ls["«executionEnvironment» localstack:3.8.1"]
            q1[["wager-transactions.fifo"]]
            q2[["wager-transactions-dlq.fifo"]]
            q3[["wager-events.fifo"]]
        end
    end
    prov["«device» Provedor de jogos"]

    prov -- "HTTP :3000-3002" --> app1
    prov -- "SQS" --> q1
    app1 -- "TCP 5432" --> db
    mig -- "TCP 5432" --> db
    app1 -- "HTTP 4566" --> q1
    app1 -- "HTTP 4566" --> q2
    app1 -- "HTTP 4566" --> q3
```

---

## Divergências conhecidas entre modelo e código

Quando o `revisor-uml` achar uma divergência, ela entra aqui até ser corrigida no código ou
no modelo.

| # | Divergência | Evidência | Situação |
|---|---|---|---|
| 1 | A tabela de transições permite `PENDING → FAILED`, mas nenhum caminho do código faz essa transição: na submissão, erro permanente desfaz a transação SQL inteira e a linha `PENDING` some. `FAILED` só é gravado no reprocessamento de `PENDING_REFERENCE` (`markFailed`). | `src/wagering/domain/wager-transaction.ts` (`TRANSITIONS`); `src/application/wager-processing.service.ts` (`markFailed`) | Aberta. Opções: remover `FAILED` das saídas de `PENDING` ou documentar que é reservada. Não afeta a correção financeira. |
