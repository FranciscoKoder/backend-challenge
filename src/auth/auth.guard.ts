import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';

/**
 * PONTO DE EXTENSÃO DE AUTENTICAÇÃO (decisão documentada em ARCHITECTURE.md §Autenticação).
 *
 * O desafio não pontua autenticação, então esta implementação deixa tudo passar. O desenho
 * pretendido: um Identity Provider externo (Keycloak/Zitadel) emite JWT via OIDC; um guard
 * valida assinatura (JWKS), `iss`, `aud` e `exp`, e o `ProviderIdentityPort` traduz as claims
 * no `providerId` autorizado. O corpo das requisições só pode falar em nome desse provider.
 */
export interface ProviderIdentity {
  /** Provedor de jogos autenticado, ou `undefined` para chamadas internas/administrativas. */
  providerId?: string;
  subject: string;
}

export interface ProviderIdentityPort {
  /** Resolve a identidade a partir do header Authorization. Lança se inválida. */
  authenticate(authorizationHeader: string | undefined): Promise<ProviderIdentity>;
}

@Injectable()
export class NoopAuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}
