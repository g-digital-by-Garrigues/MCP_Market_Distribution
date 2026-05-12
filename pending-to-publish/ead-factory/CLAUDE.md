# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install        # Install dependencies
npm run build      # Compile TypeScript → dist/
npm run dev        # Run with ts-node (no build needed, for development)
npm start          # Run compiled dist/server.js
```

No linting or test commands are configured.

### Docker

```bash
docker build -t evidence-manager-mcp .
docker run -p 3000:3000 --env-file .env evidence-manager-mcp
```

## Architecture

This is an **MCP (Model Context Protocol) server** that bridges Claude Code to a qualified digital evidence API (`g-digital-trust-api`). It exposes two tools: `generate_evidence` and `get_evidence`.

### Transport modes

- **stdio** (default): Direct connection for Claude Code — no auth required.
- **HTTP** (`TRANSPORT=http`): Remote deployment with Okta Bearer token validation. Express handles `/health` (unauthenticated) and `/mcp` (requires valid Okta Bearer token verified via Okta introspection endpoint).

### Service layer (`src/`)

```
server.ts           — MCP tool registration + transport setup
workflow.service.ts — Orchestrates the full generate_evidence flow (async generator)
auth.service.ts     — Okta client_credentials OAuth with in-memory token cache
evidence.service.ts — API calls: POST /evidences, GET /evidences/{id}
hash.service.ts     — SHA-256 file hash (hex + base64 for S3)
s3-upload.service.ts— PUT to S3 presigned URL with 3-attempt exponential backoff
config.ts           — Typed config from environment variables
http.ts             — Express HTTP transport with Okta token verification
okta-token-verifier.ts — OAuthTokenVerifier impl (Okta introspection)
```

### `generate_evidence` workflow (async generator)

`workflow.service.ts` yields progress messages at each step:
1. Validate file exists on disk
2. Authenticate with Okta → cached token
3. Calculate SHA-256 hash of file
4. POST to Evidence Manager API → receive presigned S3 URL
5. PUT file to S3 presigned URL (retry up to 3×, exponential backoff)
6. Poll GET `/evidences/{id}` until status is `COMPLETED` or `ERROR`

The server drains the generator and streams progress to the MCP client in real time.

### Environment configuration

Copy `.env.example` to `.env`. Required variables: `OKTA_TOKEN_URL`, `OKTA_CLIENT_ID`, `OKTA_CLIENT_SECRET`, `API_BASE_URL`. See README.md for per-environment URLs (INT/PRE/PRO on AWS and OCI).

`TENANT_ID` is only needed for local development to set the `X-Tenant-Id` header.

## Claude Code integration

`.claude/commands/create-internal-evidence.md` defines an interactive skill (`/create-internal-evidence`) that guides the user through creating evidence, confirms before execution, and pretty-prints the resulting certificate. This skill calls the `generate_evidence` MCP tool.