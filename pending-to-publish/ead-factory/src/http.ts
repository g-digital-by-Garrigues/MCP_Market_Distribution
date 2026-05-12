import express from 'express';
import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { OktaTokenVerifier } from './okta-token-verifier';

/**
 * Creates an Express app that serves the MCP server over Streamable HTTP
 * with Bearer token authentication via Okta.
 */
export function createHttpApp(mcpServer: McpServer): express.Express {
  const app = express();

  // Auth middleware — verifies Bearer token against Okta introspection
  const verifier = new OktaTokenVerifier();
  const authMiddleware = requireBearerAuth({ verifier });

  // Health check (no auth required)
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', server: 'evidence-manager-mcp-server' });
  });

  // Transport instances per session
  const transports = new Map<string, StreamableHTTPServerTransport>();

  // MCP endpoint with auth
  app.all('/mcp', authMiddleware, async (req, res) => {
    // For initial requests (no session), create a new transport + connect
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId && transports.has(sessionId)) {
      // Existing session — route to its transport
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res);
      return;
    }

    if (sessionId && !transports.has(sessionId)) {
      // Unknown session ID
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    // New session — create transport and connect
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        transports.delete(transport.sessionId);
      }
    };

    await mcpServer.server.connect(transport);

    if (transport.sessionId) {
      transports.set(transport.sessionId, transport);
    }

    await transport.handleRequest(req, res);
  });

  return app;
}
