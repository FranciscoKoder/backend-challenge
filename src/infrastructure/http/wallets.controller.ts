import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { formatZodIssues } from '../../application/wager-command';
import { WalletService } from '../../application/wallet.service';
import { Money } from '../../shared/domain/money';
import { UUID_REGEX } from '../../shared/domain/uuid';
import { ValidationError } from '../../shared/domain/errors';
import { WalletNotFoundError } from '../../application/errors';
import { correlationIdOf } from './correlation.middleware';

const createWalletSchema = z.object({
  playerId: z.string().trim().min(1).max(128),
  initialBalance: z.object({ amount: z.string(), currency: z.string() }),
});

const ledgerQuerySchema = z.object({
  cursor: z.string().max(256).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** Parâmetro de rota que não é UUID não pode existir: responde 404 (como wallet inexistente). */
function walletIdParam(raw: string): string {
  if (!UUID_REGEX.test(raw)) throw new WalletNotFoundError(raw);
  return raw.toLowerCase();
}

@Controller('wallets')
export class WalletsController {
  constructor(@Inject(WalletService) private readonly wallets: WalletService) {}

  @Post()
  async create(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const parsed = createWalletSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError('INVALID_PAYLOAD', formatZodIssues(parsed.error));
    const initialBalance = Money.from(parsed.data.initialBalance);
    const wallet = await this.wallets.create(
      { playerId: parsed.data.playerId, initialBalance },
      correlationIdOf(req),
    );
    res.status(201);
    return wallet;
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    return this.wallets.get(walletIdParam(walletId));
  }

  @Get(':walletId/ledger')
  async ledger(@Param('walletId') walletId: string, @Query() query: Record<string, unknown>) {
    const parsed = ledgerQuerySchema.safeParse(query);
    if (!parsed.success) throw new ValidationError('INVALID_QUERY', formatZodIssues(parsed.error));
    return this.wallets.listLedger(walletIdParam(walletId), parsed.data.cursor, parsed.data.limit);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param('walletId') walletId: string) {
    return this.wallets.reconcile(walletIdParam(walletId));
  }
}
