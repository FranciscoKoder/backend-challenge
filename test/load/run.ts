/**
 * Teste de carga: `bun run test:load`
 *
 * Dispara transações contra uma ou mais instâncias já em execução e mede latência,
 * throughput, taxa de erro, conflitos de lock e lag da outbox. No fim, reconcilia todas as
 * wallets usadas (saldo == ledger) e reenvia uma amostra para provar que replays não duplicam.
 *
 * Variáveis:
 *   LOAD_TARGETS      URLs separadas por vírgula (default http://localhost:3000)
 *   LOAD_DURATION_S   duração da fase de carga (default 30)
 *   LOAD_CONCURRENCY  requisições simultâneas (default 32)
 *   LOAD_WALLETS      wallets "frias" (default 50)
 *   LOAD_HOT_SHARE    fração do tráfego na wallet "quente" (default 0.2)
 *   LOAD_OUT          arquivo JSON com o resultado (default load-results.json)
 */
import { writeFileSync } from 'node:fs';
import { cpus, platform, totalmem } from 'node:os';

const targets = (process.env.LOAD_TARGETS ?? 'http://localhost:3000').split(',').map((s) => s.trim());
const durationS = Number(process.env.LOAD_DURATION_S ?? 30);
const concurrency = Number(process.env.LOAD_CONCURRENCY ?? 32);
const walletCount = Number(process.env.LOAD_WALLETS ?? 50);
const hotShare = Number(process.env.LOAD_HOT_SHARE ?? 0.2);
const out = process.env.LOAD_OUT ?? 'load-results.json';

interface Wallet {
  walletId: string;
  playerId: string;
}
interface Sent {
  body: Record<string, unknown>;
  key: string;
}

let rr = 0;
const target = () => targets[rr++ % targets.length]!;
const rand = (n: number) => Math.floor(Math.random() * n);
const uid = () => Math.random().toString(36).slice(2, 10);

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${target()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

async function scrapeMetrics(): Promise<Record<string, number>> {
  const totals: Record<string, number> = {};
  for (const t of targets) {
    const text = await fetch(`${t}/metrics`).then((r) => r.text()).catch(() => '');
    for (const line of text.split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^([a-z_]+)(\{[^}]*\})?\s+([-0-9.e+]+)$/);
      if (!m) continue;
      const [, name, labels = '', value] = m;
      const key = `${name}${labels}`;
      totals[key] = (totals[key] ?? 0) + Number(value);
    }
  }
  return totals;
}

function summarize(sorted: number[]) {
  return {
    count: sorted.length,
    p50: Number(percentile(sorted, 50).toFixed(1)),
    p95: Number(percentile(sorted, 95).toFixed(1)),
    p99: Number(percentile(sorted, 99).toFixed(1)),
    max: Number((sorted[sorted.length - 1] ?? 0).toFixed(1)),
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

async function main() {
  console.log(`alvos: ${targets.join(', ')} | ${durationS}s | concorrência ${concurrency}`);

  const mk = async (initial: string): Promise<Wallet> => {
    const playerId = `load-${uid()}`;
    const res = await post('/wallets', { playerId, initialBalance: { amount: initial, currency: 'BRL' } });
    if (res.status !== 201) throw new Error(`falha ao criar wallet: ${res.status} ${JSON.stringify(res.body)}`);
    return { walletId: res.body.id, playerId };
  };
  const cold = await Promise.all(Array.from({ length: walletCount }, () => mk('100000.00')));
  const hot = await mk('1000000.00');
  const metricsBefore = await scrapeMetrics();

  const latencies: number[] = [];
  const hotLatencies: number[] = [];
  const coldLatencies: number[] = [];
  const statuses: Record<string, number> = {};
  const processedBets: Array<{ w: Wallet; ext: string; amount: string; roundId: string }> = [];
  const sample: Sent[] = [];
  let networkErrors = 0;

  function nextOperation(): Sent {
    const w = Math.random() < hotShare ? hot : cold[rand(cold.length)]!;
    const ext = `ld-${uid()}`;
    const roll = Math.random();
    const amount = `${1 + rand(50)}.${String(rand(100)).padStart(2, '0')}`;
    let body: Record<string, unknown> = {
      providerId: 'load-provider',
      externalTransactionId: ext,
      playerId: w.playerId,
      walletId: w.walletId,
      roundId: `r-${rand(1000)}`,
      gameId: 'load-game',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
    };
    if (roll < 0.2) body.kind = 'WIN';
    else if (roll < 0.25) body.kind = 'LOSS';
    else if (roll < 0.3 && processedBets.length > 0) {
      const bet = processedBets.splice(rand(processedBets.length), 1)[0]!;
      body = { ...body, playerId: bet.w.playerId, walletId: bet.w.walletId, kind: 'REFUND', roundId: bet.roundId, referenceExternalTransactionId: bet.ext, money: { amount: bet.amount, currency: 'BRL' } };
    } else if (roll < 0.35 && sample.length > 0) {
      return sample[rand(sample.length)]!; // replay (mesma chave e mesmo payload)
    }
    return { body, key: `load-provider:${ext}` };
  }

  const deadline = performance.now() + durationS * 1000;
  async function worker() {
    while (performance.now() < deadline) {
      const op = nextOperation();
      const started = performance.now();
      try {
        const res = await post('/wagering/transactions', op.body, { 'Idempotency-Key': op.key });
        const ms = performance.now() - started;
        latencies.push(ms);
        (op.body.walletId === hot.walletId ? hotLatencies : coldLatencies).push(ms);
        statuses[res.status] = (statuses[res.status] ?? 0) + 1;
        if (res.status === 201 && op.body.kind === 'BET' && processedBets.length < 5000) {
          processedBets.push({
            w: { walletId: op.body.walletId as string, playerId: op.body.playerId as string },
            ext: op.body.externalTransactionId as string,
            amount: (op.body.money as { amount: string }).amount,
            roundId: op.body.roundId as string, // REFUND exige a mesma rodada
          });
        }
        if (sample.length < 200 && (res.status === 201 || res.status === 422)) sample.push(op);
      } catch {
        networkErrors += 1;
      }
    }
  }
  const startedAt = performance.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsedS = (performance.now() - startedAt) / 1000;

  // outbox: espera esvaziar e mede quanto demorou depois do fim da carga
  // (os gauges da outbox são globais: cada instância reporta o mesmo valor, por isso / N)
  const drainStart = performance.now();
  const lagAtEnd = ((await scrapeMetrics())['outbox_lag_seconds'] ?? 0) / targets.length;
  for (let i = 0; i < 240; i++) {
    const m = await scrapeMetrics();
    if ((m['outbox_pending_messages'] ?? 0) === 0) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const outboxDrainS = (performance.now() - drainStart) / 1000;
  const metricsAfter = await scrapeMetrics();

  // replays da amostra: nenhum pode criar efeito novo
  const replays = await Promise.all(sample.slice(0, 100).map((s) => post('/wagering/transactions', s.body, { 'Idempotency-Key': s.key })));
  const replayViolations = replays.filter((r) => r.body?.idempotentReplay !== true).length;

  // reconciliação de todas as wallets usadas
  const all = [hot, ...cold];
  const recon = await Promise.all(all.map((w) => post(`/wallets/${w.walletId}/reconciliation`, {})));
  const inconsistent = recon.filter((r) => r.body?.consistent !== true).length;

  const sorted = [...latencies].sort((a, b) => a - b);
  const total = latencies.length;
  const errors5xx = Object.entries(statuses).filter(([s]) => Number(s) >= 500).reduce((a, [, n]) => a + n, 0);
  const delta = (name: string) => (metricsAfter[name] ?? 0) - (metricsBefore[name] ?? 0);
  const sumMatching = (prefix: string) =>
    Object.keys(metricsAfter).filter((k) => k.startsWith(prefix)).reduce((acc, k) => acc + delta(k), 0);

  const result = {
    environment: {
      platform: platform(),
      cpus: cpus().length,
      cpuModel: cpus()[0]?.model,
      memoryGb: Math.round(totalmem() / 1024 ** 3),
      bun: Bun.version,
      targets: targets.length,
    },
    parameters: { durationS, concurrency, walletCount, hotShare },
    throughput: { requests: total, rps: Number((total / elapsedS).toFixed(1)) },
    latencyMs: summarize(sorted),
    latencyByWalletMs: {
      hot: summarize([...hotLatencies].sort((a, b) => a - b)),
      cold: summarize([...coldLatencies].sort((a, b) => a - b)),
    },
    statuses,
    errorRate: {
      http5xx: Number(((errors5xx / Math.max(1, total)) * 100).toFixed(3)),
      network: networkErrors,
    },
    concurrency: {
      walletLockConflicts: delta('wallet_lock_conflicts_total'),
      dbConflictRetries: delta('wager_retries_total{reason="db_conflict"}'),
      duplicatesDetected: sumMatching('wager_duplicates_detected_total'),
    },
    outbox: { lagSecondsAtEndOfLoad: Number(lagAtEnd.toFixed(2)), drainSeconds: Number(outboxDrainS.toFixed(2)) },
    correctness: { walletsReconciled: all.length, inconsistentWallets: inconsistent, replayViolations },
  };
  console.log(JSON.stringify(result, null, 2));
  writeFileSync(out, JSON.stringify(result, null, 2));
  if (inconsistent > 0 || replayViolations > 0) {
    console.error('FALHA DE CORREÇÃO DETECTADA');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
