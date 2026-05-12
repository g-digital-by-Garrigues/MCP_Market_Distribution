import axios from 'axios';
import { config } from './config';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

/**
 * Verifies Bearer tokens against the Okta introspection endpoint.
 * Falls back to the userinfo endpoint if introspection is not available.
 */
export class OktaTokenVerifier implements OAuthTokenVerifier {
  private introspectionUrl: string;

  constructor() {
    // Okta introspection endpoint — derive from token URL
    // Token URL format: https://{domain}/oauth2/{authServerId}/v1/token
    // Introspect URL:   https://{domain}/oauth2/{authServerId}/v1/introspect
    this.introspectionUrl = config.okta.tokenUrl.replace(/\/v1\/token$/, '/v1/introspect');
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    try {
      const response = await axios.post(
        this.introspectionUrl,
        new URLSearchParams({
          token,
          token_type_hint: 'access_token',
          client_id: config.okta.clientId,
          client_secret: config.okta.clientSecret,
        }).toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
        },
      );

      const data = response.data;

      if (!data.active) {
        throw new InvalidTokenError('Token is not active or has been revoked');
      }

      return {
        token,
        clientId: data.client_id ?? data.sub ?? 'unknown',
        scopes: data.scope ? data.scope.split(' ') : [],
        expiresAt: data.exp,
      };
    } catch (error) {
      if (error instanceof InvalidTokenError) {
        throw error;
      }
      const detail = axios.isAxiosError(error) && error.response
        ? `${error.response.status} ${error.response.statusText}`
        : error instanceof Error
          ? error.message
          : String(error);
      throw new InvalidTokenError(`Token verification failed: ${detail}`);
    }
  }
}
