import axios from 'axios';
import { config } from './config';

export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

let tokenCache: TokenCache | null = null;

const TOKEN_SAFETY_MARGIN_MS = 60_000;

export async function getToken(): Promise<string> {
  const now = Date.now();

  if (tokenCache && tokenCache.expiresAt > now + TOKEN_SAFETY_MARGIN_MS) {
    return tokenCache.accessToken;
  }

  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.okta.clientId,
    client_secret: config.okta.clientSecret,
    scope: config.okta.scope,
  });

  let response;
  try {
    response = await axios.post(config.okta.tokenUrl, params.toString(), {
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cache-Control': 'no-cache',
      },
    });
  } catch (error) {
    if (axios.isAxiosError(error) && (error.response?.status === 401 || error.response?.status === 403)) {
      throw new AuthenticationError(
        'Authentication failed: invalid or unauthorized client credentials. ' +
          'Verify OKTA_CLIENT_ID and OKTA_CLIENT_SECRET in your .env file.',
      );
    }
    throw error;
  }

  const { access_token, expires_in } = response.data;
  tokenCache = {
    accessToken: access_token,
    expiresAt: now + expires_in * 1000,
  };

  return access_token;
}

export function clearTokenCache(): void {
  tokenCache = null;
}
