# Teste de carga

`bun run test:load` ([`test/load/run.ts`](../test/load/run.ts)) dispara transações contra uma ou
mais instâncias já em execução. No fim ele reconcilia todas as wallets usadas e reenvia uma
amostra de requisições para provar que replays não criam efeito novo. Se qualquer wallet ficar
inconsistente ou algum replay gerar efeito, o processo sai com erro.

## Metodologia

- **Carga:** `LOAD_CONCURRENCY` clientes em loop fechado (cada um manda a próxima requisição
  quando a anterior responde), distribuídos em round-robin entre as instâncias.
- **Mistura de operações:** cerca de 65% BET, 20% WIN, 5% LOSS, 5% REFUND de uma BET já
  aplicada e 5% replays exatos de requisições anteriores.
- **Wallets:** 50 wallets "frias" e uma "quente" que recebe `LOAD_HOT_SHARE` do tráfego, para
  medir o efeito da serialização por wallet.
- **Medidas:** latência por requisição (p50/p95/p99/máx., separada entre wallet quente e frias),
  throughput, distribuição de status, erros, conflitos de lock e retries (via `/metrics`), lag da
  outbox ao fim da carga e tempo para esvaziá-la.
- **Correção ao final:** `POST /wallets/:id/reconciliation` em todas as wallets e reenvio de 100
  requisições da amostra.

## Ambiente medido

| Item | Valor |
|---|---|
| Máquina | AMD Ryzen 5 5600G (12 threads), 16 GB, Windows 11 |
| Runtime | Bun 1.4.2, 3 instâncias da aplicação no mesmo host, pool de 20 conexões cada |
| PostgreSQL | 18 embutido (`embedded-postgres`), `fsync=off`, `synchronous_commit=off` |
| SQS | `moto` (emulador em Python), porque esta máquina não tinha Docker |
| Gerador de carga | mesmo host (disputa CPU com as instâncias e o banco) |

Tudo no mesmo host e com `fsync` desligado. Os números servem para comparar cenários entre si,
não como capacidade de produção.

## Resultados

Duração de 30s, concorrência 32, 3 instâncias.

| Cenário | Requisições | Vazão | p50 | p95 | p99 | Erros 5xx | Wallets inconsistentes |
|---|---|---|---|---|---|---|---|
| 20% do tráfego numa wallet quente | 11.633 | 378 req/s | 5,8 ms | 493 ms | 1.534 ms | 0 | 0 de 51 |
| sem wallet quente | 32.485 | 1.082 req/s | 24,0 ms | 66,1 ms | 110,5 ms | 0 | 0 de 51 |

Latência separada no cenário com wallet quente:

| Wallets | Requisições | p50 | p95 | p99 | máx. |
|---|---|---|---|---|---|
| quente | 2.214 | 197,4 ms | 1.612,7 ms | 2.638,0 ms | 5.039,5 ms |
| frias | 9.419 | 5,3 ms | 13,9 ms | 34,5 ms | 195,4 ms |

Outros números:

| Métrica | Com wallet quente | Sem wallet quente |
|---|---|---|
| Conflitos de lock (espera > 50 ms) | 1.596 | 417 |
| Retries por deadlock/serialização | 0 | 0 |
| Duplicatas detectadas (replays) | 582 | 1.611 |
| Replays que criaram efeito | 0 | 0 |
| Erros de rede | 0 | 0 |

## Análise

1. **A wallet quente é o gargalo, e é esperado.** Todas as mutações de uma wallet passam pelo
   lock da linha. Ela fez cerca de 74 transações/s (2.214 em 30s), ou seja, uns 13 ms com o lock
   por transação. Com ~6 clientes sempre esperando por ela, a fila explica o p50 de 197 ms. As
   wallets frias quase não sentiram (p99 de 34 ms). A cauda do resultado agregado vem toda dela.
2. **Sem a wallet quente a vazão quase triplica** (378 → 1.082 req/s), mas o p50 sobe
   (5,8 → 24 ms). Antes, uns 6 dos 32 clientes ficavam parados na fila da wallet quente; sem ela,
   os 32 disputam CPU e banco ao mesmo tempo e o host satura. Isso é saturação do host, não
   contenção de lock: os conflitos caem de 1.596 para 417.
3. **Nenhum deadlock** nas duas rodadas (`db_conflict` = 0), graças ao `FOR NO KEY UPDATE` e à
   ordem fixa de locks. Uma versão anterior com `FOR UPDATE` travava no teste de concorrência da wallet
   quente (ver ARCHITECTURE.md §6).
4. **Correção:** zero 5xx, todas as wallets reconciliadas e nenhum replay com efeito novo.
5. **Lag da outbox não é representativo aqui.** Ao fim da carga havia cerca de 29s de lag e o
   esvaziamento levou cerca de 145s (≈ 370 eventos/s). Medi o emulador sozinho: o `moto` fica
   mais lento conforme a fila FIFO enche (141 → 59 → 43 msg/s em 600 mensagens). O lag reflete o
   emulador, não o publisher. Com LocalStack ou SQS real esse número precisa ser medido de novo.

## Como reproduzir

```bash
docker compose --profile app up -d --build --wait
```

```bash
LOAD_TARGETS=http://localhost:3000,http://localhost:3001,http://localhost:3002 LOAD_DURATION_S=30 LOAD_CONCURRENCY=32 LOAD_HOT_SHARE=0.2 bun run test:load
```

O resultado também é gravado em `load-results.json` (ou no caminho de `LOAD_OUT`).
