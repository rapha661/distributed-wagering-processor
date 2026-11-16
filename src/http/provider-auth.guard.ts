import { type CanActivate, Injectable } from '@nestjs/common';

/**
 * Ponto de extensão da autenticação dos provedores. Hoje deixa tudo passar: o desenho
 * previsto (OIDC client credentials com Keycloak, provedor = client, claim conferida
 * contra o providerId do payload) está descrito no ARCHITECTURE.md.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
