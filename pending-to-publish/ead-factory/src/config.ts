import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env') });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  // Transport: "stdio" for local dev with Claude Code, "http" for remote deployment
  transport: (process.env.TRANSPORT ?? 'stdio') as 'stdio' | 'http',
  httpPort: parseInt(process.env.HTTP_PORT ?? '3000', 10),

  okta: {
    tokenUrl: requireEnv('OKTA_TOKEN_URL'),
    clientId: requireEnv('OKTA_CLIENT_ID'),
    clientSecret: requireEnv('OKTA_CLIENT_SECRET'),
    scope: process.env.OKTA_SCOPE ?? 'token',
  },
  apiBaseUrl: requireEnv('API_BASE_URL'),
  signatureApiBaseUrl: requireEnv('SIGNATURE_API_BASE_URL'),
  tenantId: process.env.TENANT_ID ?? undefined,
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS ?? '3000', 10),
  pollMaxAttempts: parseInt(process.env.POLL_MAX_ATTEMPTS ?? '20', 10),
  fullFlowFilePath: path.resolve(path.join(__dirname, '..'), requireEnv('FULL_FLOW_FILE_PATH')),
  fullFlowEmailBase: requireEnv('FULL_FLOW_EMAIL_BASE'),
};
