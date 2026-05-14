import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// requireEnv used to throw at module load — that broke MCP tool discovery
// in any environment without consumer credentials (Layer 2 CI gate, Claude
// Desktop browsing the server, MCP Inspector against a fresh install).
// Now it returns '' + warns to stderr; the actual API call (auth.service /
// evidence.service / signature.service) will surface a clean 401/connection
// error when a tool is invoked without credentials. This preserves the
// fail-loudly behavior for consumers (they still see an error on first
// tool use) while letting the server start cleanly for tool discovery.
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    process.stderr.write(
      `[ead-factory] Missing env var ${name} — tool calls that need it will fail until it's set.\n`,
    );
    return '';
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
