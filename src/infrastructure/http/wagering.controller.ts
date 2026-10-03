import { Body, Controller, Get, Headers, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { TransactionNotFoundError } from '../../application/errors';
import { parseSubmitCommand } from '../../application/wager-command';
import { WagerProcessingService, type WagerOutcome } from '../../application/wager-processing.service';
import { WalletService } from '../../application/wallet.service';
import { ValidationError } from '../../shared/domain/errors';
import { UUID_REGEX } from '../../shared/domain/uuid';
import { FAILURE_ADVICE } from '../../wagering/domain/failure-code';
import { WagerTransactionStatus, type WagerTransaction } from '../../wagering/domain/wager-transaction';
import { correlationIdOf } from './correlation.middleware';

/**
 * Status HTTP da submissão (consistente com o filtro de exceções):
 *   201 PROCESSED (novo)   200 PROCESSED (replay)   422 REJECTED   202 PENDING_REFERENCE
 *   500 FAILED (erro permanente, auditável)
 */
function statusFor(outcome: WagerOutcome): number {
  switch (outcome.status) {
    case WagerTransactionStatus.Processed:
      return outcome.idempotentReplay ? 200 : 201;
    case WagerTransactionStatus.Rejected:
      return 422;
    case WagerTransactionStatus.Failed:
      return 500;
    default:
      return 202;
  }
}

function transactionView(tx: WagerTransaction) {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    status: tx.status,
    ...(tx.failureCode ? { failureCode: tx.failureCode, advice: FAILURE_ADVICE[tx.failureCode] } : {}),
    ...(tx.referenceExternalTransactionId ? { referenceExternalTransactionId: tx.referenceExternalTransactionId } : {}),
    ...(tx.referenceTransactionId ? { referenceTransactionId: tx.referenceTransactionId } : {}),
    ...(tx.resultBalance ? { balance: tx.resultBalance.toJSON() } : {}),
    createdAt: tx.createdAt.toISOString(),
    ...(tx.processedAt ? { processedAt: tx.processedAt.toISOString() } : {}),
  };
}

@Controller()
export class WageringController {
  constructor(
    @Inject(WagerProcessingService) private readonly wagering: WagerProcessingService,
    @Inject(WalletService) private readonly wallets: WalletService,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (idempotencyKey === undefined || idempotencyKey.trim() === '') {
      throw new ValidationError('MISSING_IDEMPOTENCY_KEY', 'O header Idempotency-Key é obrigatório');
    }
    const command = parseSubmitCommand(body, idempotencyKey.trim());
    const correlationId = correlationIdOf(req);
    const outcome = await this.wagering.submit(command, { source: 'http', correlationId });

    res.status(statusFor(outcome));
    return {
      transactionId: outcome.transactionId,
      status: outcome.status,
      ...(outcome.failureCode
        ? { failureCode: outcome.failureCode, advice: FAILURE_ADVICE[outcome.failureCode] }
        : {}),
      ...(outcome.balance ? { balance: outcome.balance } : {}),
      idempotentReplay: outcome.idempotentReplay,
    };
  }

  @Get('wagering/transactions/:transactionId')
  async byId(@Param('transactionId') transactionId: string) {
    if (!UUID_REGEX.test(transactionId)) throw new TransactionNotFoundError(transactionId);
    return transactionView(await this.wallets.getTransaction(transactionId.toLowerCase()));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async byProvider(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return transactionView(await this.wallets.getTransactionByProvider(providerId, externalTransactionId));
  }
}
